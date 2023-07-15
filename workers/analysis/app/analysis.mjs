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

let redis_ready = false;
const
    // Redis
    redis_client = createClient({ url: 'redis://' + env.REDIS_HOSTNAME + ':' + env.REDIS_PORT }),
    // POSTGRES
    dbconn = new Client({
      host: POSTGRES_HOST,
      user: POSTGRES_USER,
      password: POSTGRES_PASSWORD,
      database: POSTGRES_DB,
    });

redis_client.on( 'ready', () => {
  redis_ready = true;
  console.log( get_log( 'successfully connected to REDIS at ' + 'redis://' + env.REDIS_HOSTNAME + ':' + env.REDIS_PORT ) );
});
redis_client.on( 'error', ( err ) => {
  if ( !redis_ready ) {
    console.log( get_log( 'Exception while trying to connect to Redis via ' + env.REDIS_HOSTNAME + ':' + env.REDIS_PORT + "\n" + err.toString() ) );
    exit( 1 );
  }
});

await redis_client.connect();

// this is here to test Redis publishing, nothing more - the actual channel message isn't being received by anyone
await redis_client.publish( 'TEST_RUN', CLIENT_ID );

if ( !POSTGRES_DB || !POSTGRES_PASSWORD || !POSTGRES_USER ) {
  let log_msg = get_log( 'missing one of POSTGRES environment variables' );
  console.log( log_msg );

  redis_client.publish( REDIS_LOGS_CHANNEL, JSON.stringify({
    'service' : SERVICE_ID,
    'severity' : 'error',
    'code' : redis_client.get( 'ERR_POSTGRES_MISSING_CONNECTION_DATA' ),
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

    redis_client.publish( REDIS_LOGS_CHANNEL, JSON.stringify({
      'service' : SERVICE_ID,
      'severity' : 'error',
      'code' : redis_client.get( 'ERR_POSTGRES_CANNOT_CONNECT' ),
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
redis_client.publish( REDIS_LOGS_CHANNEL, JSON.stringify({
  'service' : SERVICE_ID,
  'severity' : 'log',
  'code' : 0,
  'time' : Date.now(),
  'msg' : log_msg,
}));

console.log( log_msg );

// subscribe to RSS new links channel, so we can update statistics for links amount per day, month and year
let
    feed_last_link_timeout_id = [], // a setTimeout() ID for the last of the feed links published that gets
                                          // executed in 30 seconds after that last feed link to update stats data for that feed
    feed_messages_received_counter = []; // number of messages received from a single feed while we're in a wait loop,
                                               // waiting for at least 30 seconds after the last message from that feed
                                               // before we write statistical data for this feed into the DB

redis_client.subscribe( REDIS_NEW_LINKS_CHANNEL, ( msg, channel ) => {
  let original_msg = msg;
  msg = JSON.parse( msg );

  if ( msg ) {
    // increment count of the messages received for this feed in this batch
    if ( !feed_messages_received_counter[ msg.feed_url ] ) {
      feed_messages_received_counter[ msg.feed_url ] = 1;
    } else {
      feed_messages_received_counter[ msg.feed_url ]++;
    }

    // cancel old timeout for this feed, if present
    if ( feed_last_link_timeout_id[ msg.feed_url ] ) {
      clearTimeout( feed_last_link_timeout_id[ msg.feed_url ] );
    }

    // create a new function to execute in 30 seconds for the DB stats update
    feed_last_link_timeout_id[ msg.feed_url ] = setTimeout( () => {
      let dt = new Date();

      try {
        console.log( get_log( 'writing stats data for ' + msg.feed_url ) );
        inc_stories_per_hour_query.values = [msg.feed_url, dt.getHours(), daysIntoYear(dt), dt.getFullYear(), feed_messages_received_counter[msg.feed_url]];
        dbconn.query(inc_stories_per_hour_query);

        inc_stories_per_day_query.values = [msg.feed_url, dt.getDay(), dt.getWeek(), dt.getFullYear(), feed_messages_received_counter[msg.feed_url]];
        dbconn.query(inc_stories_per_day_query);

        inc_stories_per_month_query.values = [msg.feed_url, dt.getMonth(), dt.getFullYear(), feed_messages_received_counter[msg.feed_url]];
        dbconn.query(inc_stories_per_month_query);

        feed_messages_received_counter[msg.feed_url] = 0;
        feed_last_link_timeout_id[msg.feed_url] = 0;
        console.log( get_log( 'stats data successfully updated for ' + msg.feed_url ) );
      } catch ( err ) {
        let log_msg = get_log( 'Exception while trying to save statistical feed data of ' + msg.feed_url + '\n' + err.toString() );
        console.log( log_msg );

        redis_client.publish( REDIS_LOGS_CHANNEL, JSON.stringify({
          'service' : SERVICE_ID,
          'severity' : 'error',
          'code' : redis_client.get( 'ERR_ANALYSIS_FEED_FREQUENCY_UPDATE_FAILURE' ),
          'time' : Date.now(),
          'msg' : log_msg,
        }));
      }
    }, 30000 );
  } else {
    let log_msg = get_log( 'Exception while trying to decode RSS link data: ' + original_msg );
    console.log( log_msg );

    redis_client.publish( REDIS_LOGS_CHANNEL, JSON.stringify({
      'service' : SERVICE_ID,
      'severity' : 'error',
      'code' : redis_client.get( 'ERR_RSS_FETCH_PUSHED_INVALID_LINK_DATA' ),
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