import { env, exit } from 'node:process';
import { LOG_SEVERITIES, Logger } from './Logger.js';
import pkg from "pg";
import { KafkaProducer } from './KafkaProducer.js';
import { KafkaConsumer } from './KafkaConsumer.js';

export class LinkWriter {

  /**
   * Main app client identifier
   * @private
   */
  private readonly client_id: string;

  /**
   * Main app service ID, so we can use it in Kafka logs.
   * @private
   * @type { string }
   */
  private readonly service_id: string;

  /**
   * Instance of the Logger class.
   * @private
   * @type { Logger }
   */
  private readonly logger: Logger;

  /**
   * Instance of the KafkaProducer used for message publishing
   * sections of the code.
   * @private
   * @type { KafkaProducer }
   */
  private readonly kafka_producer: KafkaProducer;

  /**
   * Instance of the KafkaConsumer used to listen
   * for RSS feeds to parse.
   * @private
   * @type { KafkaConsumer }
   */
  private readonly kafka_consumer: KafkaConsumer;

  /**
   * Redis client instance, used to fetch error codes.
   * @type { any }
   * @private
   */
  private readonly redis_client: any;

  /**
   * PostgreSQL client class instance.
   * @private
   * @type { pkg.Client }
   */
  private readonly dbconn: pkg.Client;

  /**
   * A setTimeout() ID for the last of the feed links published
   * that get executed in 20 seconds after that last feed link
   * to allow for stats data update.
   *
   * @private
   * @type { Array<any> }
   */
  private feed_last_link_timeout_id: Array<any> = [];

  /**
   * Number of messages successfully inserted into the DB
   * from a single feed while we're in a wait loop,
   * waiting for at least 20 seconds after the last message
   * from that feed before we publish a log for this feed
   * that will update stats in the DB.
   *
   * @private
   * @type { Object }
   */
  private feed_messages_inserted_counter: Object = {};

  /**
   * Timestamp of the first item received in a single batch
   * for a single RSS feed. Used to compare the last update
   * of the RSS feed as such and potentially shorten our waiting
   * time between fetches once the feed resumes its publishing state.
   *
   * @private
   * @type { Object }
   */
  private feed_first_batch_item_ts: Object = [];

  /**
   * Temporary cached feed urls to IDs.
   *
   * @private
   * @type { Object }
   */
  private feed_url_to_id: Object = {};

  /**
   * New ilnks channel name.
   * @private
   * @type { string }
   */
  private links_channel_name: string;

  /**
   * Stores references to Redis, PGSQL and Logger classes
   * that were created outside of this main class.
   *
   * @param { string }        client_id      ID of the main application client, so we can determine who posted
   *                                         a new link message and don't react to our own messages
   * @param { string }        service_id     ID of the service from main application for Kafka publishing purposes
   * @param { KafkaProducer } kafka_producer Kafka Producer used to publish messages.
   * @param { KafkaConsumer } kafka_consumer Kafka Consumer used to listen for RSS feeds to parse.
   * @param { Logger }        logger         A Logger class instanced used for logging purposes.
   * @param { any }           redisClient    A Redis client to fetch error codes.
   * @param { pkg.Client }    dbconn         A PGSQL client instance.
   */
  constructor( client_id: string, service_id: string, kafka_producer: KafkaProducer, kafka_consumer: KafkaConsumer, logger: Logger, redisClient: any, dbconn: pkg.Client ) {
    // Kafka
    this.kafka_producer = kafka_producer;
    this.kafka_consumer = kafka_consumer;

    // Logger
    this.logger = logger;

    // Database
    this.dbconn = dbconn;

    // Redis
    this.redis_client = redisClient;

    // strings
    this.client_id = client_id;
    this.service_id = service_id;
    this.links_channel_name = env.KAFKA_NEW_LINKS_CHANNEL;

    let self = this;

    // create a task that will update this service active status every minute
    setInterval( (): void => {
      if ( self.kafka_consumer.get_active() && self.kafka_producer.get_active() ) {
        self.redis_client.set( self.service_id + '_active', 1 );
      }
    }, 60000 );

    // mark ourselves as active from the start, if both - producer and consumer - are active
    if ( this.kafka_consumer.get_active() && this.kafka_producer.get_active() ) {
      this.redis_client.set( this.service_id + '_active', 1 );
    }

    // subscribe to RSS new links channel, so we can write their data out to the database
    this.kafka_consumer.subscribe( [ this.links_channel_name ] ).then( async () => {
      // start processing newfound links
      if ( !await self.kafka_consumer.consume( self.parse_link.bind( this ) ) ) {
        let exit_code: number = parseInt( await self.redis_client.get( 'ERR_RSS_FETCH_KAFKA_NOT_READY' ) );
        await self.logger.log_msg( 'Error while trying to set link parsing function - Kafka Consumer not ready.', exit_code );
        exit( exit_code );
      }

      // publish info about our instance going live
      await this.logger.log_msg( self.service_id + ' up and running', 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );
    });
  }

  /**
   * Parses the link received and tries to write its data into DB.
   *
   * @param { Object } data This is the data received from Kafka consumer.
   *                        Object structure: topic, partition, message, heartbeat, pause
   * @private
   */
  private async parse_link( { topic, partition, message, heartbeat, pause } ): Promise<void> {
    if ( topic == this.links_channel_name ) {
      let original_msg: string = message.value.toString();
      message                      = JSON.parse( message.value.toString() );

      if ( message ) {
        // check that the service publishing this message is not in fact a Link Writer
        if ( message.service != this.service_id ) {

          // see if we have cached feed ID for this URL
          if ( await this.checkAndCacheFeedURL( message.feed_url ) ) {

            // try inserting the link into the DB
            const text: string       = 'INSERT INTO unprocessed_links( feed_id, title, description, link, img, date_posted ) VALUES( $1, $2, $3, $4, $5, $6 ) RETURNING id';
            const values: Array<any> = [ this.feed_url_to_id[ message.feed_url ], message.title, message.description, message.link, message.img, message.published ];

            try {
              const res = await this.dbconn.query( text, values );
              if ( res.rows.length ) {
                // check and store first item's timestamp for this batch and this feed
                if (!this.feed_first_batch_item_ts[ message.feed_url ] || message.date < this.feed_first_batch_item_ts[ message.feed_url ]) {
                  this.feed_first_batch_item_ts[ message.feed_url ] = message.date;
                }

                // increment count of the messages inserted for this feed in this batch
                if (!this.feed_messages_inserted_counter[ message.feed_url ]) {
                  this.feed_messages_inserted_counter[ message.feed_url ] = 1;
                } else {
                  this.feed_messages_inserted_counter[ message.feed_url ]++;
                }

                // no await here, as we don't really need to wait or care too much for this log message - it's mostly a debug msg
                this.logger.log_msg( 'Successfully inserted into db: ' + message.link + '\n', 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );
              } else {
                // we couldn't insert this record into the DB for some reason, publish an error into the log
                await this.logger.log_msg( 'Could not insert link into db: ' + message.link + '\n' + res.toString() + '\ndata: ' + original_msg, 'ERR_LINK_WRITER_NO_RECORD_WRITTEN' );
                this.update_internals_when_link_fails_to_insert( message );
              }
            } catch ( err ) {
              // ignore duplicate errors, since we have unique url field in the DB
              // which ensures a certain level of de-duplication
              if ( ( err.detail && err.detail.indexOf( 'already exists' ) == -1) || !err.detail ) {
                // this is a non-duplication error, log it
                await this.logger.log_msg( 'DB error while trying to insert new link data:\n' + JSON.stringify( err ) + '\ndata: ' + original_msg, 'ERR_LINK_WRITER_DB_WRITE_ERROR' );
              } else {
                // since this is a valid duplicate link, update data
                // to be sent to fetch interval updating service
                this.update_internals_when_link_fails_to_insert( message );
              }
            }

            // cancel old timeout for this feed, if present
            if (this.feed_last_link_timeout_id[ message.feed_url ]) {
              clearTimeout(this.feed_last_link_timeout_id[ message.feed_url ]);
            }

            // create a new function to execute in 20 seconds for the DB stats update
            // ... we do this independently on whether we were able to insert link data into DB
            //     or not, since we need to update fetch intervals even if we don't insert a single link
            //     and in such case, statistical info will remain unchanged
            this.feed_last_link_timeout_id[ message.feed_url ] = setTimeout(() => {
              if (this.feed_messages_inserted_counter[ message.feed_url ] != 'undefined') {
                this.kafka_producer.pub_item( {
                  'service': this.service_id,
                  'severity': LOG_SEVERITIES.LOG_SEVERITY_NOTICE,
                  'extra_data': {
                    'feed_url':      message.feed_url,
                    'links_count':   this.feed_messages_inserted_counter[ message.feed_url ],
                    'first_item_ts': this.feed_first_batch_item_ts[ message.feed_url ],
                  },
                });
              }

              delete this.feed_messages_inserted_counter[ message.feed_url ];
              delete this.feed_first_batch_item_ts[ message.feed_url ];
              this.feed_last_link_timeout_id[ message.feed_url ] = 0;
            }, 20000);
          }
        }
      } else {
        await this.logger.log_msg( 'Exception while trying to decode RSS link data: ' + original_msg, 'ERR_RSS_FETCH_PUSHED_INVALID_LINK_DATA' );
      }
    }
  }

  /**
   * Updates our internal inserted links counter
   * as well as first batch item TS values when a link
   * fails to get inserted into the DB (either by our own
   * mistake in code or because it is a duplicate link).
   *
   * @param msg
   * @private
   * @return void
   */
  private update_internals_when_link_fails_to_insert( msg: Object ): void {
    if ( !this.feed_messages_inserted_counter ) {
      this.feed_messages_inserted_counter[ msg['feed_url'] ] = 0;
    }

    if ( !this.feed_first_batch_item_ts[ msg['feed_url'] ] ) {
      this.feed_first_batch_item_ts[ msg['feed_url'] ] = ( msg && msg['date'] ? msg['date'] : Math.round( Date.now() / 1000 ) );
    }
  }

  /**
   * Checks whether we have feed_id -> feed_url mapping present
   * for the given feed and caches it if we don't. Also creates
   * a cleanup task to remove the cached value after 45 minutes
   * of feed inactivity.
   *
   * @param { string } feed_url The feed URL to check for ID mapping existance.
   * @private
   *
   * @return { Promise<boolean> } Returns true if the feed was successfully cached,
   *                              false otherwise.
   */
  private async checkAndCacheFeedURL( feed_url: string ): Promise<boolean> {
    let ret: boolean = true;

    if ( !this.feed_url_to_id[ feed_url ] ) {
      const res_feeds = await this.dbconn.query( 'SELECT id FROM feeds WHERE url = $1', [ feed_url ] );
      if ( res_feeds.rows.length ) {
        this.feed_url_to_id[ feed_url ] = res_feeds.rows[ 0 ].id;
      } else {
        this.feed_url_to_id[ feed_url ] = -1;

        // we couldn't get link ID for this feed, log error
        await this.logger.log_msg( 'Could not find feed in database: ' + feed_url, 'ERR_LINK_WRITER_NO_RSS_FEED_RECORD' );
        ret = false;
      }

      // clean up this feed's ID cache after 45 minutes, so we clear up some memory
      // if the feed is not being updated that frequently
      setTimeout( () => {
        delete this.feed_url_to_id[ feed_url ];
      }, 1000 * 60 * 45 );
    }

    return ret;
  }
}