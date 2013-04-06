#!/bin/env node
//  OpenShift sample Node application
var express = require('express');
var fs      = require('fs');
var mongodb = require('mongodb');
var http = require('http');
var io = require('socket.io');

var config = require('./config.js');

/**
 *  Define the sample application.
 */
var SampleApp = function() {

    //  Scope.
    var self = this;


    /*  ================================================================  */
    /*  Helper functions.                                                 */
    /*  ================================================================  */

    /**
     *  Set up server IP address and port # using env variables/defaults.
     */
    self.setupVariables = function() {
        //  Set the environment variables we need.
        self.ipaddress = process.env.OPENSHIFT_INTERNAL_IP;
        self.port      = 8000;//process.env.OPENSHIFT_INTERNAL_PORT || 8080;

        if (typeof self.ipaddress === "undefined") {
            //  Log errors on OpenShift but continue w/ 127.0.0.1 - this
            //  allows us to run/test the app locally.
            console.warn('No OPENSHIFT_INTERNAL_IP var, using 127.0.0.1');
            self.ipaddress = "127.0.0.1";
        };
    };


    /**
     *  Populate the cache.
     */
    self.populateCache = function() {
        if (typeof self.zcache === "undefined") {
            self.zcache = { 'index.html': '' };
        }

        //  Local cache for static content.
        self.zcache['index.html'] = fs.readFileSync('./index.html');
    };

    self.initializeMongoDb = function() {
        var mongoUser = process.env.OPENSHIFT_MONGODB_DB_USERNAME || null;
        var mongoPass = process.env.OPENSHIFT_MONGODB_DB_PASSWORD || null;
        var mongoIp = process.env.OPENSHIFT_MONGODB_DB_HOST || "127.0.0.1";
        var mongoPort = process.env.OPENSHIFT_MONGODB_DB_PORT || 27017;

        var server = new mongodb.Server(mongoIp, mongoPort, {});
        self.mongoStorage = new mongodb.Db('twitterstream', server, {safe:false, auto_reconnect: true});
        self.mongoStorage.open(function(){
            if(mongoUser != null && mongoPass != null) {
                self.mongoStorage.authenticate(mongoUser, mongoPass, function(err, res) {});
            }
        });

    };

    self.initializeTwitter = function() {
        var Twit = require('twit');


        self.twitter = new Twit({
            consumer_key: config.twitter.consumerKey,
            consumer_secret: config.twitter.consumerSecret,
            access_token: config.twitter.accessToken,
            access_token_secret: config.twitter.accessTokenSecret
        })
    }

    /**
     *  Retrieve entry (content) from cache.
     *  @param {string} key  Key identifying content to retrieve from cache.
     */
    self.cache_get = function(key) { return self.zcache[key]; };


    /**
     *  terminator === the termination handler
     *  Terminate server on receipt of the specified signal.
     *  @param {string} sig  Signal to terminate on.
     */
    self.terminator = function(sig){
        if (typeof sig === "string") {
           console.log('%s: Received %s - terminating sample app ...',
                       Date(Date.now()), sig);
           process.exit(1);
        }
        console.log('%s: Node server stopped.', Date(Date.now()) );
    };


    /**
     *  Setup termination handlers (for exit and a list of signals).
     */
    self.setupTerminationHandlers = function(){
        //  Process on exit and signals.
        process.on('exit', function() { self.terminator(); });

        // Removed 'SIGPIPE' from the list - bugz 852598.
        ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT',
         'SIGBUS', 'SIGFPE', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGTERM'
        ].forEach(function(element, index, array) {
            process.on(element, function() { self.terminator(element); });
        });
    };


    /*  ================================================================  */
    /*  App server functions (main app logic here).                       */
    /*  ================================================================  */

    /**
     *  Create the routing table entries + handlers for the application.
     */
    self.createRoutes = function() {
        self.routes = { };

        self.routes['/tweetscount'] = function (req, res) {
            self.mongoStorage.collection("tweets", function (err, collection) {
                collection.count(function (err, count) {
                    res.set('Content-Type', 'text/html');
                    res.send(count);
                });
            });

        };

        // Routes for /health, /asciimo, /env and /
        self.routes['/health'] = function(req, res) {
            res.send('1');
        };

        self.routes['/env'] = function(req, res) {
            var content = 'Version: ' + process.version + '\n<br/>\n' +
                          'Env: {<br/>\n<pre>';
            //  Add env entries.
            for (var k in process.env) {
               content += '   ' + k + ': ' + process.env[k] + '\n';
            }
            content += '}\n</pre><br/>\n'
            res.send(content);
            res.send('<html>\n' +
                     '  <head><title>Node.js Process Env</title></head>\n' +
                     '  <body>\n<br/>\n' + content + '</body>\n</html>');
        };

        self.routes['/'] = function(req, res) {
            res.set('Content-Type', 'text/html');
            res.send(self.cache_get('index.html') );
        };
    };


    /**
     *  Initialize the server (express) and create the routes and register
     *  the handlers.
     */
    self.initializeServer = function() {
        self.createRoutes();
        self.app = express();
        self.app.use('/public', express.static(__dirname + '/public'));

        //  Add handlers for the app (from the routes).
        for (var r in self.routes) {
            self.app.get(r, self.routes[r]);
        }
    };

    self.startMonitor = function () {
        var stream = self.twitter.stream('statuses/filter', {track: config.monitor.keywords});
        stream.on('tweet', function (tweet) {
            self.mongoStorage.collection("tweets", function (err, collection) {
                tweet['timestamp'] = Date.now();
                collection.insert(tweet);
            });


            if (typeof self.websocketListeners !== "undefined") {
                self.websocketListeners.forEach(function (callback) {
                    callback(tweet);
                });
            }

            console.log("New tweet stored");

        });
    };

    self.startSender = function () {
        setInterval(function () {
            try {

                console.log("Sending tweets to url " + config.submit.url);
                var querystring = require('querystring');

                self.mongoStorage.collection("tweets", function (err, collection) {


                    // TODO: replace with real last timestam
                    var prevDate = Date.now() - 60000; // 60sec


                    var criteria = {"timestamp": {"$gt": prevDate}};
                    collection.find(criteria).toArray(function (err, results) {
                        console.log("Found " + results.length + " tweets to send");

                        if (results.length > 0) {
                            var data = results;
                            var request = require('request');

                            request.post(
                                config.submit.url,
                                { form: { tweets: data } },
                                function (error, response, body) {
                                    if (!error && response.statusCode == 200) {
                                        console.log(body)
                                    } else {
                                        console.log(error);
                                    }
                                }
                            );
                        } else {
                            console.log("No tweet to submit, skipping");
                        }

                    });
                });


            }
            catch (err) {
                console.log("ERROR: " + err);
            }
        }, config.submit.period);
    };


    /**
     *  Initializes the sample application.
     */
    self.initialize = function() {
        self.setupVariables();
        self.populateCache();
        self.setupTerminationHandlers();

        self.initializeMongoDb();

        self.initializeTwitter();

        // Create the express server and routes.
        self.initializeServer();

        // Start twitter stream monitoring
        self.startMonitor();
        // Start sending stored tweets to defined url
        self.startSender();
    };


    /**
     *  Start the server (starts up the sample application).
     */
    self.start = function () {

        var server = require('http').createServer(self.app);
        var io = require('socket.io').listen(server);


        //  Start the app on the specific interface (and port).
        server.listen(self.port, self.ipaddress, function () {
            console.log('%s: Node server started on %s:%d ...',
                Date(Date.now()), self.ipaddress, self.port);

            self.websocketListeners = [];
            self.sockets = io;
            self.sockets.on('connection', function (socket) {
                self.websocketListeners.push(function (tweet) {
                    socket.volatile.emit('tweet', tweet);
                });
            });


        });
    };

};


/**
 *  main():  Main code.
 */
var zapp = new SampleApp();
zapp.initialize();
zapp.start();

