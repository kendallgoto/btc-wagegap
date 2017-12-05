require('dotenv').config();
var rest = require('restler');
var Gdax = require('gdax');
var nodemailer = require('nodemailer');

var publicClient = new Gdax.PublicClient();
let transporter = nodemailer.createTransport({
    host: process.env.NOTIFY_SERVER,
    port: process.env.NOTIFY_PORT,
    secure: true, 
    auth: {
        user: process.env.NOTIFY_USERNAME, 
        pass: process.env.NOTIFY_PASSWORD  
    }
});

var mailOptions = {
    from: process.env.NOTIFY_USERNAME,
    to: process.env.NOTIFY_EMAIL,
    subject: 'BTC Delta price detected!',
    text: ''
};


rest.get('https://api.cryptowat.ch/markets/'+process.env.EXCHANGE+'/btcusd/price').on('complete', function(result) {
  if (result instanceof Error) {
	  return;
  } else {
	var cryptPrice = result.result.price;
	publicClient.getProductOrderBook(function(error, response, data) {
	  if (!error) {
		  var GdaxPrice = (parseFloat(data.bids[0][0]) + parseFloat(data.asks[0][0])) / 2;
		  var delta = cryptPrice - GdaxPrice;
		  //delta = -450
		  console.log("delta is $"+delta);
		  if(delta > 0) {
			  return;
		  }
	  
		  if(delta < process.env.DELTA_AMT * -1) {
			  console.log("High delta detected!");
			  mailOptions.text = "A delta price has been detected! -- GDAX at $" + GdaxPrice.toFixed(2) + " and Cryptowatch at $"+cryptPrice.toFixed(2) + " (delta: $"+delta.toFixed(2)+")";
			  if(process.env.NOTIFY && process.env.NOTIFY != "false")
			  	transporter.sendMail(mailOptions, (error, info) => {});
			  
			  //Since we're over the delta, let's start our purchasing.
			  //authenticate w/ gdax
			  var apiURI = 'https://api.gdax.com';
			  	  //apiURI = 'https://api-public.sandbox.gdax.com';

			  var authedClient = new Gdax.AuthenticatedClient(process.env.GDAX_PUB, process.env.GDAX_API_KEY, process.env.GDAX_PASS, apiURI);
			  authedClient.getAccount(process.env.GDAX_ACCOUNT_ID, function(error, response, data) {
				  var balance = data.available;
				  console.log(data);
				  var toDrain = balance * parseFloat(process.env.LIQUID);
				  console.log("Draining "+toDrain+"BTC");
				  if(toDrain == 0) {
					  return;
				  }
				  
				  //Sell all of this BTC.
				  var sellPrice = (GdaxPrice - parseFloat(process.env.LOSS)).toFixed(2);
				  var sellParams = {
				    'price': sellPrice,
				    'size': toDrain.toFixed(5),
				    'product_id': 'BTC-USD',
					'time_in_force': 'GTT',
					'cancel_after': 'min'
				  };
				  if(sellPrice < parseFloat(process.env.ANTISLIP)) {
					  console.log("TRANSACTION WILL NOT PROCEED -- SLIPPAGE TOO HIGH (selling "+toDrain.toFixed(5)+"BTC for $"+sellPrice+")");
					  return;
				  }
				  //PREVENT SLIPPAGE
				  authedClient.sell(sellParams, function(error, response, data) {
					  if(error || typeof data.id === "undefined") {
						  console.log("GDAX is experiencing errors. NO BTC IS SOLD");
						  return;
					  }
					  console.log(data);
					  var ourOrder = data.id;
					  //Our sale is now pending. We hae DELTA_HOLDTIME until we want to buy back a position.
					  var hasSold = data.settled;
					  var hasBoughtBack = false;
					  var timeIterations = 1;
					  var pending = setInterval(function() {
						  if(!hasSold) {
							  //We still haven't sold our value ...
							  //Lets wait a third of our time allowance before giving up in this case.
							  //Check if we've sold
							  authedClient.getOrder(ourOrder, function(error, response, data) {
								  console.log(data);
								  if(data.settled && data.status == 'rejected') {
								  	//we failed :(
									hasSold = false;
									timeIterations = parseInt(process.env.DELTA_HOLDTIME);
								  } else {
								  	hasSold = data.settled;
							  	}
							  });
							  if(timeIterations > 0.33*parseInt(process.env.DELTA_HOLDTIME) && !hasSold) {
								  console.log("DELTA SALE FAILED -- BTC AMT WAS NOT PURCHASED. cancelling...");
								  authedClient.cancelOrder(ourOrder, function(){});
								  clearInterval(pending);
							  }
							  timeIterations++;
							  return;
						  }
						  //If we _did_ sell our position, now we will wait for the price change.
						  if(hasBoughtBack) {
							  clearInterval(pending);
							  return;
						  }
						  publicClient.getProductOrderBook(function(error, response, data) {
							  if(error) {
							  	//error in fetching price... um... that's not good.
								  console.log("MARKET PRICE COULD NOT BE FETCHED ...");
							  }
							  var livePrice = (parseFloat(data.bids[0][0]) + parseFloat(data.asks[0][0])) / 2;
							  console.log("PRICECHECK AT "+livePrice);
							  //wait for livePrice to match our expectation
							  if((livePrice - GdaxPrice < -1 * parseFloat(delta * process.env.DELTA_LOWER_CATCH)) ||
						  		 (livePrice - GdaxPrice > parseFloat(delta * process.env.DELTA_RISE_CATCH)) ||
						  		 (timeIterations > parseInt(process.env.DELTA_HOLDTIME))) {
								  //We've reached our minimum -- buy back
									 hasBoughtBack = true;
								  const buyParams = {
								    'price': (livePrice + parseFloat(process.env.LOSS)).toFixed(2), // USD
								    'size': toDrain.toFixed(5),  // BTC
								    'product_id': 'BTC-USD',
								  };
								  if((livePrice + parseFloat(process.env.LOSS)).toFixed(2) > process.env.ANTISLIP_HIGH) {
									  console.log("TRANSACTION WILL NOT PROCEED -- SLIPPAGE TOO HIGH");
									  return;
								  }
								  authedClient.buy(buyParams, function(error, response, data) {
									  console.log('BUYING BACK AT MARKET RATE');
									  var buyBack = data.id;
								  });
							  }
						  });						  
						  
						  timeIterations++;
					  }, 1000);
				  });
				  
			  });
		  }
	  }
	});
  }
});
