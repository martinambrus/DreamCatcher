import { env, exit } from 'node:process';
import { exec } from 'node:child_process';
import { createClient } from 'redis';
import pkg from 'pg';

const { Client } = pkg;
const time_start = performance.now();
const REDIS_LOGS_CHANNEL = env.REDIS_LOGS_CHANNEL;
const POSTGRES_HOST = env.POSTGRES_HOST;
const POSTGRES_USER = env.POSTGRES_USER;
const POSTGRES_PASSWORD = env.POSTGRES_PASSWORD;
const POSTGRES_DB = env.POSTGRES_DB;
const CLIENT_ID = 'control-center';
const SERVICE_ID = 'control_center';

if ( !REDIS_LOGS_CHANNEL ) {
  console.log( 'ERROR: configuration environment variables not set\nplease run this script as: source env.sh && node control-center.mjs' );
}

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

const time_end = performance.now();
console.log( 'Control Center script started after ' + ( Math.round( time_end - time_start, 3 ) * 1000 ) + 'ms of init' );

// run a notification script to fetch new articles every 5 minutes
setInterval( async function() {
  // first, update all feeds with 10+ subsequent failures
  // where last fetch was more than 2 days ago
  await dbconn.query(`
    UPDATE feeds SET
      subsequent_errors_counter = 0,
      last_error_ts = 0,
      fetch_interval_minutes = 5,
      subsequent_stable_fetch_intervals = 0
    WHERE
      subsequent_errors_counter > 10
      AND
      last_error_ts > ` + ( Date.now() - (60 * 60 * 24 * 2) ) // now minus 2 days
  );

  // assemble all feeds with the following parameters:
  // -> at least 1 normal/premium user subscribed
  // -> next_fetch_ts >= current time
  // -> subsequent errors counter less than 10
  try {
    let res = await dbconn.query(`
      SELECT url FROM feeds WHERE
        ( normal_subscribers > 0 OR premium_subscribers > 0 )
        AND
        (
          ( next_fetch_ts = 0 OR next_fetch_ts <= ${Date.now()} )
          AND
          subsequent_errors_counter < 10
        )
    `);

    for ( let i in res.rows ) {
      // fire up rss fetch containers
      run_rss_fetch_container( i, res.rows[ i ].url );
    }
  } catch ( err ) {
    let log_msg = get_log( 'Exception while trying to save retrieve rss feeds to fetch\n' + err.toString() );
    console.log( log_msg );

    redis_client.publish( REDIS_LOGS_CHANNEL, JSON.stringify({
      'service' : SERVICE_ID,
      'severity' : 'error',
      'code' : redis_client.get( 'ERR_CONTROL_PANEL_CANNOT_FETCH_FEEDS' ),
      'time' : Date.now(),
      'msg' : log_msg,
    }));

    await dbconn.end();
    exit(); // forever will restart the control panel and reconnect to DB
  }
}, 1000 * 60 * 5); // run every 5 minutes

function get_log( msg ) {
  let dt = new Date();
  return '[' + dt.getDate() + '.' + dt.getMonth() + '.' + dt.getFullYear() + ' ' + dt.getHours() + ':' + dt.getMinutes() + ':' + dt.getSeconds() + '] ' + CLIENT_ID + ': ' + msg;
}

function run_rss_fetch_container( container_id, feed_url ) {
  exec('docker compose -f docker-compose.yml -f <(echo -e "services:\\n  rss_fetch:\\n    container_name: rss_fetch_' + container_id + '\n    hostname: rss_fetch_' + container_id + '\n    environment:\\n      - TEST_RUN=0\\n      - FEED_URL=' + feed_url + '") run -d --rm rss_fetch', {shell: "/bin/bash"}, (error, stdout, stderr) => {
    if (error) {
      let log_msg = get_log( 'Error (1) starting rss_fetch container for feed ' + feed_url + '\n' + error.toString() );
      console.log( log_msg );

      redis_client.publish( REDIS_LOGS_CHANNEL, JSON.stringify({
        'service' : SERVICE_ID,
        'severity' : 'error',
        'code' : redis_client.get( 'ERR_CONTROL_PANEL_CANNOT_START_RSS_FETCH_CONTAINER' ),
        'time' : Date.now(),
        'msg' : log_msg,
      }));
      return;
    }

    if (stderr && stderr.indexOf(' Running') == -1 ) {
      let log_msg = get_log( 'Error (2) starting rss_fetch container for feed ' + feed_url + '\n' + stderr );
      console.log( log_msg );

      redis_client.publish( REDIS_LOGS_CHANNEL, JSON.stringify({
        'service' : SERVICE_ID,
        'severity' : 'error',
        'code' : redis_client.get( 'ERR_CONTROL_PANEL_CANNOT_START_RSS_FETCH_CONTAINER' ),
        'time' : Date.now(),
        'msg' : log_msg,
      }));
      return;
    }

    console.log(`started rss_fetch container for ${feed_url}, stdout: ${stdout}`);
  });
}