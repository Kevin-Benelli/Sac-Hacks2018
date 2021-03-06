'use strict'

const express = require('express');
const path = require('path');
const _ = require('lodash');
const Promise = require('bluebird');
const bodyParser = require('body-parser');
const envvar = require('envvar');
const exphbs = require('express-handlebars');
const session = require('cookie-session');
const opn = require('opn');
const url = require('url');
require('dotenv').config();
const PORT = process.env.PORT || 5000;
const validator = require('validator');
const smartcar = require('smartcar');
const mongoose = require('mongoose');

const port = process.env.PORT || 5000;


const questRoutes = require('./server/routes/quests');

const app = express();



app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Origin, X-Requested-With, Content-Type, Accept, Authorization'
    );
    res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, PATCH, PUT, DELETE, OPTIONS'
    );
    next();
});

app.use(bodyParser.urlencoded({
    extended: false
}));

mongoose.connect(process.env.MONGO_URL, {
    useNewUrlParser: true
})
    .then(() => {
        console.log('Connnected to database!');
    })
    .catch(() => {
        console.log('Database connection failed!');
    });

mongoose.set('useCreateIndex', true);

app.use('/api/quests/', questRoutes);


const SMARTCAR_CLIENT_ID = envvar.string('SMARTCAR_CLIENT_ID');
const SMARTCAR_SECRET = envvar.string('SMARTCAR_SECRET');

// Validate Client ID and Secret are UUIDs
if (!validator.isUUID(SMARTCAR_CLIENT_ID)) {
    throw new Error('CLIENT_ID is invalid. Please check to make sure you have replaced CLIENT_ID with the Client ID obtained from the Smartcar developer dashboard.');
}

if (!validator.isUUID(SMARTCAR_SECRET)) {
    throw new Error('SMARTCAR_SECRET is invalid. Please check to make sure you have replaced SMARTCAR_SECRET with your Client Secret obtained from the Smartcar developer dashboard.');
}

// Redirect uri must be added to the application's allowed redirect uris
// in the Smartcar developer portal
const SMARTCAR_REDIRECT_URI = envvar.string('SMARTCAR_REDIRECT_URI', `/callback`);

// Setting MODE to "test" will run the Smartcar auth flow in test mode
const SMARTCAR_MODE = envvar.oneOf('SMARTCAR_MODE', ['test', 'live'], 'test');


const client = new smartcar.AuthClient({
    clientId: SMARTCAR_CLIENT_ID,
    clientSecret: SMARTCAR_SECRET,
    redirectUri: SMARTCAR_REDIRECT_URI,
    testMode: SMARTCAR_MODE === 'test',
});

/**
 * Configure express server with handlebars as the view engine.
 */

app.use(session({
    name: 'demo-session',
    secret: 'super-duper-secret',
}));
app.engine('.hbs', exphbs({
    defaultLayout: 'main',
    extname: '.hbs',
}));
app.set('view engine', '.hbs');

/**
 * Render home page with a "Connect your car" button.
 */
app.get('/car', function (req, res, next) {


    res.json([{
        authUrl: client.getAuthUrl(),
        testMode: SMARTCAR_MODE === 'test',
    }]);

});

/**
 * Helper function that redirects to the /error route with a specified
 * error message and action.
 */
const redirectToError = (res, message, action) => res.redirect(url.format({
    pathname: '/error',
    query: { message, action },
}));

/**
 * Render error page. Displays the action that was attempted and the error
 * message associated with that action (extracted from query params).
 */
app.get('/error', function (req, res, next) {

    const { action, message } = req.query;
    if (!action && !message) {
        return res.redirect('/');
    }

    res.render('error', { action, message });

});

/**
 * Disconnect each vehicle to cleanly logout.
 */
app.get('/logout', function (req, res, next) {
    const { access, vehicles } = req.session;
    return Promise.map(_.keys(vehicles), (id) => {
        const instance = new smartcar.Vehicle(id, access.accessToken);
        return instance.disconnect();
    })
        .finally(() => {
            req.session = null;
            res.redirect('/');
        });

});

/**
 * Called on return from the Smartcar authorization flow. This route extracts
 * the authorization code from the url and exchanges the code with Smartcar
 * for an access token that can be used to make requests to the vehicle.
 */
app.get('/callback', function (req, res, next) {
    const code = _.get(req, 'query.code');
    if (!code) {
        return res.redirect('/');
    }

    // Exchange authorization code for access token
    client.exchangeCode(code)
        .then(function (access) {
            req.session = {};
            req.session.vehicles = {};
            req.session.access = access;
            //pass back to front end for user login
            // res.send(access);;
            // console.log(access)
            // console.log(user.id);
            return res.redirect('/vehicles');
        })
        .catch(function (err) {
            const message = err.message || `Failed to exchange authorization code for access token`;
            const action = 'exchanging authorization code for access token';
            return redirectToError(res, message, action);
        });

});

/**
 * Renders a list of vehicles. Lets the user select a vehicle and type of
 * request, then sends a POST request to the /request route.
 */
app.get('/vehicles', function (req, res, next) {
    const { access, vehicles } = req.session;
    if (!access) {
        return res.redirect('/');
    }
    const { accessToken } = access;
    smartcar.getVehicleIds(accessToken)
        .then(function (data) {
            const vehicleIds = data.vehicles;
            const vehiclePromises = vehicleIds.map(vehicleId => {
                const vehicle = new smartcar.Vehicle(vehicleId, accessToken);
                req.session.vehicles[vehicleId] = {
                    id: vehicleId,
                };

                return vehicle.info();
            });

            return Promise.all(vehiclePromises)
                .then(function (data) {
                    // Add vehicle info to vehicle objects
                    _.forEach(data, vehicle => {
                        const { id: vehicleId } = vehicle;
                        req.session.vehicles[vehicleId] = vehicle;
                    });

                    res.render('vehicles', { vehicles: req.session.vehicles });
                })
                .catch(function (err) {
                    const message = err.message || 'Failed to get vehicle info.';
                    const action = 'fetching vehicle info';
                    return redirectToError(res, message, action);
                });
        });

});

/**
 * Triggers a request to the vehicle and renders the response.
 */
app.post('/request', function (req, res, next) {
    const { access, vehicles } = req.session;
    res.send(JSON(access));
    if (!access) {
        return res.redirect('/');
    }

    const { vehicleId, requestType: type } = req.body;
    const vehicle = vehicles[vehicleId];
    const instance = new smartcar.Vehicle(vehicleId, access.accessToken);


    let data = null;

    switch (type) {
        case 'info':
            instance.info()
                .then(data => res.render('data', { data, type, vehicle }))
                .catch(function (err) {
                    const message = err.message || 'Failed to get vehicle info.';
                    const action = 'fetching vehicle info';
                    return redirectToError(res, message, action);
                });
            break;
        case 'location':
            instance.location()
                .then((data) => res.render('data', { data, type, vehicle }))
                .catch(function (err) {
                    const message = err.message || 'Failed to get vehicle location.';
                    const action = 'fetching vehicle location';
                    return redirectToError(res, message, action);
                });
            break;
        case 'odometer':
            instance.odometer()
                .then(({ data }) => res.render('data', { data, type, vehicle }))
                .catch(function (err) {
                    const message = err.message || 'Failed to get vehicle odometer.';
                    const action = 'fetching vehicle odometer';
                    return redirectToError(res, message, action);
                });
            break;
        default:
            return redirectToError(
                res,
                `Failed to find request type ${requestType}`,
                'sending request to vehicle'
            );
    }

});









// Serve the static files from the React app
app.use(express.static(path.join(__dirname, 'client/build')));








// An api endpoint that returns a short list of items
app.get('/api/getList', (req, res) => {
    res.send('Connected');
});



// Handles any requests that don't match the ones above
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname + '/client/build/index.html'));
});





app.listen(port);

console.log('App is listening on port ' + port);


