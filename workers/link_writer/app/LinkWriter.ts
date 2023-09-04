import { env, exit } from 'node:process';
import { Telemetry } from './Telemetry.js';
import { IKeyStoreSub } from './MQ/KeyStore/Interfaces/IKeyStoreSub.js';
import { IKeyStorePub } from './MQ/KeyStore/Interfaces/IKeyStorePub.js';
import { ILogger, LOG_SEVERITIES } from './MQ/KeyStore/Interfaces/ILogger.js';
import { IMessageQueuePub } from './MQ/KeyStore/Interfaces/IMessageQueuePub.js';
import { IMessageQueueSub } from './MQ/KeyStore/Interfaces/IMessageQueueSub.js';
import { IDatabase } from './Database/Interfaces/IDatabase.js';

export class LinkWriter {

  /**
   * Current version of this service.
   * Must be changed for each production-ready release.
   * @private
   * @type { string }
   */
  private readonly version: string = '0.1a';

  /**
   * Main app service ID, so we can use it in MQ logs.
   * @private
   * @type { string }
   */
  private readonly service_id: string;

  /**
   * Instance of the Logger class.
   * @private
   * @type { ILogger }
   */
  private readonly logger: ILogger;

  /**
   * Instance of the MQ Producer used for message publishing
   * sections of the code.
   * @private
   * @type { IMessageQueuePub }
   */
  private readonly mq_producer: IMessageQueuePub;

  /**
   * Instance of the MQ Consumer used to listen
   * for RSS feeds to parse.
   * @private
   * @type { IMessageQueueSub }
   */
  private readonly mq_consumer: IMessageQueueSub;

  /**
   * Key store subscriber client instance,
   * used to subscribe to channels.
   * @type { IKeyStoreSub }
   * @private
   */
  private readonly key_store_sub: IKeyStoreSub;

  /**
   * Key store publisher and getter client instance,
   * used to fetch error codes.
   * @type { IKeyStorePub }
   * @private
   */
  private readonly key_store_pub: IKeyStorePub;

  /**
   * PostgreSQL client class instance.
   * @private
   * @type { IDatabase }
   */
  private readonly dbconn: IDatabase;

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
   * A cache of Telemetry objects, so we don't
   * re-create them for each link which has the same
   * trace ID. We'll reuse the same Telemetry class instead
   * and remove it once it expires.
   * @private
   * @type { { [k: string] : Telemetry } }
   */
  private telemetry_cache: { [k: string] : Telemetry } = {};

  /**
   * Maximum number of seconds for a trace to be without
   * any activity in order to consider it inactive and remove
   * its class from the list of cached Telemetries.
   * @private
   * @type { number }
   */
  private readonly telemetry_inactive_timeout_seconds: number = 300;

  /**
   * Stores references to key store, PGSQL and Logger classes
   * that were created outside of this main class.
   *
   * @param { string }           service_id    ID of the service from main application for MQ publishing purposes
   * @param { IMessageQueuePub } mq_producer   MQ Producer used to publish messages.
   * @param { IMessageQueueSub } mq_consumer   MQ Consumer used to listen for RSS feeds to parse.
   * @param { ILogger }          logger        A Logger class instanced used for logging purposes.
   * @param { IDatabase }        dbconn        A Database class instance.
   * @param { IKeyStoreSub }     key_store_sub A Key Store Sub client to subscribe to channels.
   * @param { IKeyStorePub }     key_store_pub A Key Store Pub client to fetch error codes.
   */
  constructor( service_id: string, mq_producer: IMessageQueuePub, mq_consumer: IMessageQueueSub, logger: ILogger, dbconn: IDatabase, key_store_sub: IKeyStoreSub, key_store_pub: IKeyStorePub ) {
    // MQ
    this.mq_producer = mq_producer;
    this.mq_consumer = mq_consumer;

    // Logger
    this.logger = logger;

    // Database
    this.dbconn = dbconn;

    // key store
    this.key_store_sub = key_store_sub;
    this.key_store_pub = key_store_pub;

    // strings
    this.service_id = service_id;
    this.links_channel_name = env.NEW_LINKS_CHANNEL_NAME;

    // publish info about our instance going live
    this.logger.log_msg( 'link_writer up and running', 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );

    let self = this;

    // create a task that will update this service active status every minute
    // ... this is here in case Redis goes down, so we can show that we are alive again
    setInterval( (): void => {
      self.key_store_pub.set( self.service_id + '_active', 1 );
    }, 60000 );

    // mark ourselves as active
    this.key_store_pub.set( this.service_id + '_active', 1 );

    // subscribe to RSS new links channel, so we can write their data out to the database
    this.mq_consumer.consume( this.links_channel_name, self.parse_link.bind( this ) );

    // keep checking for timed out telemetries and close them when they do time out
    setInterval( function(): void {
      let
        new_active_telemetries: { [k: string] : Telemetry } = {},
        current_timestamp: number = Math.round( Date.now() / 1000 );

      for ( let telemetry_instance in self.telemetry_cache ) {
        // check whether this telemetry was inactive long enough
        if ( current_timestamp - self.telemetry_cache[ telemetry_instance ].get_last_activity() <= self.telemetry_inactive_timeout_seconds ) {
          new_active_telemetries[ telemetry_instance ] = self.telemetry_cache[ telemetry_instance ];
        }
      }

      if ( Object.keys( new_active_telemetries ).length != Object.keys( self.telemetry_cache ).length ) {
        self.telemetry_cache = new_active_telemetries;
      }
    }, 63000); // check every minute (actually 63 seconds because the telemetry timeout is set to 300s exactly)
  }

  /**
   * Parses the link received and tries to write its data into DB.
   *
   * @param { Object } data This is the processed data received from Kafka consumer.
   *                        Object structure: topic, message, trace_id
   * @private
   */
  private async parse_link( { topic, message, trace_id } ): Promise<any> {
    const
      trace_carrier: Object   = JSON.parse( trace_id ),
      link_telemetry: Telemetry = ( this.telemetry_cache[ trace_id ] ?? await new Telemetry( this.service_id, this.version, ( message.link ?? '' ) ).start( trace_carrier ) ),
      link_check_span_name: string = 'link_check',
      link_db_write_span_name: string = 'link_db_write',
      link_mq_pub_span_name: string = 'link_mq_pub',
      error_log_span_name: string = 'error_log';

    // check that the service publishing this message is not in fact a Link Writer
    if ( message.service != this.service_id ) {
      // cache this Telemetry class if not cached already
      this.telemetry_cache[ trace_id ] = ( this.telemetry_cache[ trace_id ] ?? link_telemetry );
      await link_telemetry.add_span( link_check_span_name, { 'link' : message.link } );

      // see if we have cached feed ID for this URL
      this.checkAndCacheFeedURL( message.feed_url ).then( async ( result: boolean ) => {
        link_telemetry.close_active_span( link_check_span_name );

        if ( result ) {
          await link_telemetry.add_span( link_db_write_span_name, { 'link' : message.link } );

          // try inserting the link into the DB
          try {
            await this.dbconn.insert_link( this.feed_url_to_id[ message.feed_url ], message.title, message.description, message.link, message.img, message.published );

            // check and store first item's timestamp for this batch and this feed
            if ( !this.feed_first_batch_item_ts[ message.feed_url ] || message.date < this.feed_first_batch_item_ts[ message.feed_url ] ) {
              this.feed_first_batch_item_ts[ message.feed_url ] = message.date;
            }

            // increment count of the messages inserted for this feed in this batch
            if ( !this.feed_messages_inserted_counter[ message.feed_url ] ) {
              this.feed_messages_inserted_counter[ message.feed_url ] = 1;
            } else {
              this.feed_messages_inserted_counter[ message.feed_url ]++;
            }

            // no await here, as we don't really need to wait or care too much for this log message - it's mostly a debug msg
            //this.logger.log_msg( 'Successfully inserted into db: ' + message.link + '\n', 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );
          } catch ( err ) {
            // ignore duplicate errors, since we have unique url field in the DB
            // which ensures a certain level of de-duplication
            if ( ( err.detail && err.detail.indexOf( 'already exists' ) == -1 ) || !err.detail ) {
              // this is a non-duplication error, log it
              this.logger.log_msg( 'DB error while trying to insert new link data:\n' + JSON.stringify( err ) + '\ndata: ' + JSON.stringify( message ), 'ERR_LINK_WRITER_DB_WRITE_ERROR' );
              await link_telemetry.add_span( error_log_span_name, { 'link_url' : message.link }, 'DB error while trying to insert new link data:\n' + JSON.stringify( err ) + '\ndata: ' + JSON.stringify( message ), 1 );
              link_telemetry.close_active_span( error_log_span_name );
            } else {
              // since this is a valid duplicate link, update data
              // to be sent to fetch interval updating service
              this.update_internals_when_link_fails_to_insert( message );
            }
          }

          link_telemetry.close_active_span( link_db_write_span_name );

          // cancel old timeout for this feed, if present
          if ( this.feed_last_link_timeout_id[ message.feed_url ] ) {
            clearTimeout( this.feed_last_link_timeout_id[ message.feed_url ] );
          }

          // create a new function to execute in 20 seconds for the DB stats update
          // ... we do this independently on whether we were able to insert link data into DB
          //     or not, since we need to update fetch intervals even if we don't insert a single link
          //     and in such case, statistical info will remain unchanged
          this.feed_last_link_timeout_id[ message.feed_url ] = setTimeout( async () => {
            if ( this.feed_messages_inserted_counter[ message.feed_url ] != 'undefined' ) {
              await link_telemetry.add_span( link_mq_pub_span_name );

              await this.mq_producer.send( env.LOGS_CHANNEL_NAME, {
                'service':    this.service_id,
                'severity':   LOG_SEVERITIES.LOG_SEVERITY_NOTICE,
                'extra_data': {
                  'feed_url':      message.feed_url,
                  'links_count':   this.feed_messages_inserted_counter[ message.feed_url ],
                  'first_item_ts': this.feed_first_batch_item_ts[ message.feed_url ],
                }
              }, trace_id );

              link_telemetry.close_active_span( link_mq_pub_span_name );

              // publish to key store that we're done with tracing
              this.key_store_pub.publish( env.TELEMETRY_CHANNEL_NAME, JSON.stringify( { service: this.service_id, trace_id: trace_id } ) );
            }

            delete this.feed_messages_inserted_counter[ message.feed_url ];
            delete this.feed_first_batch_item_ts[ message.feed_url ];
            this.feed_last_link_timeout_id[ message.feed_url ] = 0;
          }, 20000 );
        }
      });
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
      try {
        const res_id: bigint = await this.dbconn.get_feed_id_from_url( feed_url );
        if ( res_id ) {
          this.feed_url_to_id[ feed_url ] = res_id;
        } else {
          this.feed_url_to_id[ feed_url ] = 0;

          // we couldn't get link ID for this feed, log error
          // no await - we're returning boolean that's manually set below
          this.logger.log_msg( 'Could not find feed in database: ' + feed_url, 'ERR_LINK_WRITER_NO_RSS_FEED_RECORD' );
          ret = false;
        }

        // clean up this feed's ID cache after 45 minutes, so we clear up some memory
        // if the feed is not being updated that frequently
        setTimeout( () => {
          delete this.feed_url_to_id[ feed_url ];
        }, 1000 * 60 * 45 );
      } catch ( err ) {
        // no await - we're returning boolean that's manually set below
        this.logger.log_msg( 'Database error trying to get feed info from DB: ' + JSON.stringify( err ), 'ERR_LINK_WRITER_DB_READ_ERROR' );
        ret = false;
      }
    }

    return ret;
  }
}