import { env, exit } from 'node:process';
import { performance } from 'node:perf_hooks';
import { createClient } from 'redis';
import pkg from 'pg';

const { Client } = pkg;
const time_start = performance.now();
const REDIS_NEW_LINKS_CHANNEL = env.REDIS_NEW_LINKS_CHANNEL;
const REDIS_LOGS_CHANNEL = env.REDIS_LOGS_CHANNEL;
const POSTGRES_HOST = env.POSTGRES_HOST;
const POSTGRES_USER = env.POSTGRES_USER;
const POSTGRES_PASSWORD = env.POSTGRES_PASSWORD;
const POSTGRES_DB = env.POSTGRES_DB;
const CLIENT_ID = ( env.HOSTNAME ? env.HOSTNAME : 'analysis_undefined_host' );
const SERVICE_ID = 'analysis';

// wait 5 seconds for other containers to start and init
await new Promise(resolve => setTimeout(resolve, 5000));

let
  redis_pub_ready = false,
  redis_sub_ready = false;

const
    // Redis
    redis_pub_client = createClient({ url: 'redis://' + env.REDIS_HOSTNAME + ':' + env.REDIS_PORT }),
    redis_sub_client = createClient({ url: 'redis://' + env.REDIS_HOSTNAME + ':' + env.REDIS_PORT }),
    // POSTGRES
    dbconn = new Client({
      host: POSTGRES_HOST,
      user: POSTGRES_USER,
      password: POSTGRES_PASSWORD,
      database: POSTGRES_DB,
    });

redis_pub_client.on( 'ready', () => {
  redis_pub_ready = true;
  console.log( get_log( 'successfully connected to REDIS (pub) at ' + 'redis://' + env.REDIS_HOSTNAME + ':' + env.REDIS_PORT ) );
});
redis_pub_client.on( 'error', ( err ) => {
  if ( !redis_pub_ready ) {
    console.log( get_log( 'Exception while trying to connect to Redis (pub) via ' + env.REDIS_HOSTNAME + ':' + env.REDIS_PORT + "\n" + err.toString() ) );
    exit( 1 );
  }
});

redis_sub_client.on( 'ready', () => {
  redis_sub_ready = true;
  console.log( get_log( 'successfully connected to REDIS (sub) at ' + 'redis://' + env.REDIS_HOSTNAME + ':' + env.REDIS_PORT ) );
});
redis_sub_client.on( 'error', ( err ) => {
  if ( !redis_sub_ready ) {
    console.log( get_log( 'Exception while trying to connect to Redis (sub) via ' + env.REDIS_HOSTNAME + ':' + env.REDIS_PORT + "\n" + err.toString() ) );
    exit( 1 );
  }
});

await redis_pub_client.connect();
await redis_sub_client.connect();

// this is here to test Redis publishing, nothing more - the actual channel message isn't being received by anyone
await redis_pub_client.publish( 'TEST_RUN', CLIENT_ID );

if ( !POSTGRES_DB || !POSTGRES_PASSWORD || !POSTGRES_USER ) {
  let log_msg = get_log( 'missing one of POSTGRES environment variables' );
  console.log( log_msg );

  redis_pub_client.publish( REDIS_LOGS_CHANNEL, JSON.stringify({
    'service' : SERVICE_ID,
    'severity' : 'error',
    'code' : redis_pub_client.get( 'ERR_POSTGRES_MISSING_CONNECTION_DATA' ),
    'time' : Date.now(),
    'msg' : log_msg,
  }));

  exit();
} else {
  // try to connect to PGSQL
  try {
    await dbconn.connect();
  } catch ( err ) {
    let log_msg = get_log( 'could not connect to POSTGRES\n' +err.toString() );
    console.log( log_msg );

    redis_pub_client.publish( REDIS_LOGS_CHANNEL, JSON.stringify({
      'service' : SERVICE_ID,
      'severity' : 'error',
      'code' : redis_pub_client.get( 'ERR_POSTGRES_CANNOT_CONNECT' ),
      'time' : Date.now(),
      'msg' : log_msg,
    }));

    exit();
  }
}

// prepare statistical statements for re-use
let inc_stories_per_day_query = {
  name: 'inc_stories_per_day',
  text: 'SELECT inc_stories_per_day( $1, $2, $3, $4, $5 )',
};

let inc_stories_per_month_query = {
  name: 'inc_stories_per_month',
  text: 'SELECT inc_stories_per_month( $1, $2, $3, $4 )',
};

let inc_stories_per_hour_query = {
  name: 'inc_stories_per_hour',
  text: 'SELECT inc_stories_per_hour( $1, $2, $3, $4, $5 )',
};

const time_end = performance.now();
let log_msg = get_log( 'subscribing to Redis channels after ' + ( Math.round( time_end - time_start, 3 ) * 1000 ) + 'ms of init' );
redis_pub_client.publish( REDIS_LOGS_CHANNEL, JSON.stringify({
  'service' : SERVICE_ID,
  'severity' : 'log',
  'code' : 0,
  'time' : Date.now(),
  'msg' : log_msg,
}));

console.log( log_msg );

// subscribe to RSS new links channel, so we can update statistics for links amount per day, month and year
// once the link writer publishes its new links counter
redis_sub_client.subscribe( REDIS_NEW_LINKS_CHANNEL, ( msg, channel ) => {
  let original_msg = msg;
  msg = JSON.parse( msg );

  if ( msg ) {
    // check that we have the right message
    if ( msg.service.indexOf( 'link_writer' ) > -1 ) {
      let dt = new Date();

      try {
        console.log( get_log( 'writing stats data for ' + msg.msg.feed_url ) );
        inc_stories_per_hour_query.values = [msg.msg.feed_url, dt.getHours(), daysIntoYear(dt), dt.getFullYear(), msg.msg.links_count ];
        dbconn.query(inc_stories_per_hour_query);

        inc_stories_per_day_query.values = [msg.msg.feed_url, dt.getDay(), dt.getWeek(), dt.getFullYear(), msg.msg.links_count ];
        dbconn.query(inc_stories_per_day_query);

        inc_stories_per_month_query.values = [msg.msg.feed_url, dt.getMonth(), dt.getFullYear(), msg.msg.links_count ];
        dbconn.query(inc_stories_per_month_query);
      } catch ( err ) {
        let log_msg = get_log( 'Exception while trying to save statistical feed data of ' + msg.msg.feed_url + '\n' + err.toString() );
        console.log( log_msg );

        redis_pub_client.publish( REDIS_LOGS_CHANNEL, JSON.stringify({
          'service' : SERVICE_ID,
          'severity' : 'error',
          'code' : redis_pub_client.get( 'ERR_ANALYSIS_FEED_FREQUENCY_UPDATE_FAILURE' ),
          'time' : Date.now(),
          'msg' : log_msg,
        }));
      }
    }
  } else {
    let log_msg = get_log( 'Exception while trying to decode Link Writer log data: ' + original_msg );
    console.log( log_msg );

    redis_pub_client.publish( REDIS_LOGS_CHANNEL, JSON.stringify({
      'service' : SERVICE_ID,
      'severity' : 'error',
      'code' : redis_pub_client.get( 'ERR_LINK_WRITER_INVALID_LOG_MSG' ),
      'time' : Date.now(),
      'msg' : log_msg,
    }));
  }
});



// helper functions
function daysIntoYear( date ) {
  return ( Date.UTC( date.getFullYear(), date.getMonth(), date.getDate() ) - Date.UTC( date.getFullYear(), 0, 0 ) ) / 24 / 60 / 60 / 1000;
}

function get_log( msg ) {
  let dt = new Date();
  return '[' + dt.getDate() + '.' + dt.getMonth() + '.' + dt.getFullYear() + ' ' + dt.getHours() + ':' + dt.getMinutes() + ':' + dt.getSeconds() + '] ' + CLIENT_ID + ': ' + msg;
}

Date.prototype.getWeek = function() {
  var date = new Date(this.getTime());
  date.setHours(0, 0, 0, 0);
  // Thursday in current week decides the year.
  date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
  // January 4 is always in week 1.
  var week1 = new Date(date.getFullYear(), 0, 4);
  // Adjust to Thursday in week 1 and count number of weeks from date to week1.
  return 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}