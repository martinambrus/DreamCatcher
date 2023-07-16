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
const CLIENT_ID = ( env.HOSTNAME ? env.HOSTNAME : 'link_writer_undefined_host' );
const SERVICE_ID = 'link_writer';

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

// subscribe to RSS new links channel
let
    feed_last_link_timeout_id = [],      // a setTimeout() ID for the last of the feed links published that gets
                                               // executed in 20 seconds after that last feed link to allow for stats data update

    feed_messages_inserted_counter = [], // number of messages successfully inserted into the DB from a single feed
                                               // while we're in a wait loop, waiting for at least 20 seconds after
                                               // the last message from that feed before we publish a log for this feed
                                               // that will update stats in the DB

    feed_url_to_id = {};                    // temporary cached feed urls to IDs

redis_sub_client.subscribe( REDIS_NEW_LINKS_CHANNEL, async ( msg, channel ) => {
  let original_msg = msg;
  msg = JSON.parse( msg );

  if ( msg ) {
    // check that the service publishing this message is not in fact a Link Writer
    if ( msg.service.indexOf( CLIENT_ID ) == -1 ) {
      // cancel old timeout for this feed, if present
      if ( feed_last_link_timeout_id[ msg.feed_url ] ) {
        clearTimeout( feed_last_link_timeout_id[ msg.feed_url ] );
      }

      // see if we have cached feed ID for this URL
      if ( !feed_url_to_id[ msg.feed_url ] ) {
        const res_feeds = await dbconn.query( 'SELECT id FROM feeds WHERE url = $1', [ msg.feed_url ] );
        if ( res_feeds.rows.length ) {
          feed_url_to_id[ msg.feed_url ] = res_feeds.rows[ 0 ].id;
        } else {
          feed_url_to_id[ msg.feed_url ] = -1;

          // we couldn't get link ID for this feed, log error
          let log_msg = get_log( 'Could not find feed in database: ' + msg.feed_url );
          console.log( log_msg );

          redis_pub_client.publish( REDIS_LOGS_CHANNEL, JSON.stringify({
            'service' : SERVICE_ID,
            'severity' : 'error',
            'code' : redis_pub_client.get( 'ERR_LINK_WRITER_NO_RSS_FEED_RECORD' ),
            'time' : Date.now(),
            'msg' : log_msg,
          }));
        }

        // clean up this feed's ID cache after 45 minutes, so we clear up some memory
        // if the feed is not being updated that frequently
        setTimeout( () => {
          delete feed_url_to_id[ msg.feed_url ];
        }, 1000 * 60 * 45 );
      }

      // check whether the feed url to ID is not -1, which would be a serious error,
      // since we wouldn't have a feed to link to the URL
      if ( feed_url_to_id[ msg.feed_url ] && feed_url_to_id[ msg.feed_url ] > -1 ) {

        // try inserting the link into the DB
        const text = 'INSERT INTO unprocessed_links(feed_id, title, description, link, img, date_posted) VALUES($1, $2, $3, $4, $5, $6) RETURNING id';
        const values = [ feed_url_to_id[ msg.feed_url ], msg.title, msg.description, msg.link, msg.img, msg.date ];

        try {
          const res = await dbconn.query(text, values);
          if ( res.rows.length ) {
            // increment count of the messages inserted for this feed in this batch
            if ( !feed_messages_inserted_counter[ msg.feed_url ] ) {
              feed_messages_inserted_counter[ msg.feed_url ] = 1;
            } else {
              feed_messages_inserted_counter[ msg.feed_url ]++;
            }

            let log_msg = get_log( 'Successfully inserted into db: ' + msg.link + '\n' );
            console.log( log_msg );
          } else {
            // we couldn't insert this record into the DB for some reason, publish an error into the log
            let log_msg = get_log( 'Could not insert link into db: ' + msg.link + '\n' + res.toString() );
            console.log( log_msg );

            redis_pub_client.publish( REDIS_LOGS_CHANNEL, JSON.stringify({
              'service' : SERVICE_ID,
              'severity' : 'error',
              'code' : redis_pub_client.get( 'ERR_LINK_WRITER_NO_RECORD_WRITTEN' ),
              'time' : Date.now(),
              'msg' : log_msg,
            }));
          }
        } catch ( err ) {
          // ignore duplicate errors, since we have unique url field in the DB which ensures a certain level of de-duplication
          if ( err.detail.indexOf( 'already exists' ) == -1 ) {

            // this is a non-duplication error, log it
            let log_msg = get_log( 'DB error while trying to insert new link data:\n' + err.toString() );
            console.log( log_msg );

            redis_pub_client.publish( REDIS_LOGS_CHANNEL, JSON.stringify({
              'service' : SERVICE_ID,
              'severity' : 'error',
              'code' : redis_pub_client.get( 'ERR_LINK_WRITER_DB_WRITE_ERROR' ),
              'time' : Date.now(),
              'msg' : log_msg,
            }));
          }
        }
      }

      // create a new function to execute in 20 seconds for the DB stats update
      feed_last_link_timeout_id[ msg.feed_url ] = setTimeout( () => {
        redis_pub_client.publish( REDIS_NEW_LINKS_CHANNEL, JSON.stringify({
          'service' : SERVICE_ID,
          'time' : Date.now(),
          'msg' : {
            'feed_url' : msg.feed_url,
            'links_count' : feed_messages_inserted_counter[ msg.feed_url ],
          },
        }));

        feed_messages_inserted_counter[ msg.feed_url ] = 0;
        feed_last_link_timeout_id[ msg.feed_url ] = 0;
      }, 20000 );
    }
  } else {
    let log_msg = get_log( 'Exception while trying to decode RSS link data: ' + original_msg );
    console.log( log_msg );

    redis_pub_client.publish( REDIS_LOGS_CHANNEL, JSON.stringify({
      'service' : SERVICE_ID,
      'severity' : 'error',
      'code' : redis_pub_client.get( 'ERR_RSS_FETCH_PUSHED_INVALID_LINK_DATA' ),
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