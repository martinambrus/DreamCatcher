  import { env, exit } from "node:process";
import { LOG_SEVERITIES } from "./Logger.js";
import { Logger } from "./Logger.js";
import { KafkaProducer } from "./KafkaProducer.js";
import pkg from "pg";

export class ControlCenter {

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
   * List of all known services that need to send activation message
   * via Redis, so the Control Center knows we are in a healthy state
   * and can start checking for RSS feeds in need of fetching.
   * @private
   * @type { Array<string> }
   */
  private readonly all_services_list: Array<string> = [ 'rss_fetch', 'analysis', 'link_writer', 'link_fix_detector' ];

  /**
   * When this is true, we are in an active state
   * and can process feed data from database.
   * @private
   * @type { boolean }
   */
  private active: boolean = false;

  /**
   * Stores references to Kafka, PGSQL and Logger classes
   * that were created outside of this main class.
   *
   * @param { KafkaProducer } kafka_producer Kafke Producer used to publish messages.
   * @param { Logger }        logger         A Logger class instanced used for logging purposes.
   * @param { pkg.Client }    dbconn         A PGSQL client instance.
   * @param { any }           redisClient    A Redis client to fetch error codes.
   */
  constructor( kafka_producer: KafkaProducer, logger: Logger, dbconn: pkg.Client, redisClient: any ) {
    this.kafka_producer = kafka_producer;
    this.logger = logger;
    this.dbconn = dbconn;
    this.redis_client = redisClient;

    // publish info about our instance going live
    this.logger.log_msg( 'control center up and running, checking feeds every ' + env.RSS_CHECK_INTERVAL_SECONDS + ' seconds', 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );

    let self = this;

    // keep checking for a Redis status where all services write their active states,
    // and if there's any service not active yet, wait until ALL are active
    setInterval( async function(): Promise<void> {
      let all_active: boolean = true;

      for ( let service_name of self.all_services_list ) {
        // check Redis for active state of the service
        if ( await self.redis_client.get( service_name + '_active' ) !== '1' ) {
          all_active = false;
          console.log( self.logger.get_log( 'service ' + service_name + ' not ready' ) );
        }
      }

      // wait until all services are active - set our active flag to false if they aren't
      self.active = all_active;
    }, 57000); // check every minute - in case Redis drops, all services will re-submit their OK states into it
                   // when it runs again

    // run a notification script to fetch new articles every 5 minutes
    setInterval( async function(): Promise<void> {
      if ( self.active ) {
        // first, update all feeds with 10+ subsequent failures
        // where last fetch was more than 2 days ago
        await self.dbconn.query(`
          UPDATE feeds SET
            subsequent_errors_counter = 0,
            last_error_ts = 0,
            fetch_interval_minutes = 5,
            subsequent_stable_fetch_intervals = 0
          WHERE
            subsequent_errors_counter > 10
            AND
            last_error_ts > ` + ( Math.round( Date.now() / 1000 ) - (60 * 60 * 24 * 2) ) // now minus 2 days
        );

        // assemble all feeds with the following parameters:
        // -> at least 1 normal/premium user subscribed
        // -> next_fetch_ts >= current time
        // -> subsequent errors counter less than 10
        try {
          let res = await self.dbconn.query(`
            SELECT url FROM feeds WHERE
              ( normal_subscribers > 0 OR premium_subscribers > 0 )
              AND
              active = 1
              AND
              (
                ( next_fetch_ts = 0 OR next_fetch_ts <= ${Math.round( Date.now() / 1000 )} )
                AND
                subsequent_errors_counter < 10
              )
          `);

          for ( let i in res.rows ) {
            // send RSS feed URLs to the rss_fetch service for processing
            // note: we don't use await here, so we can fire up Kafka messages fast
            self.kafka_producer.pub_feed( { url: res.rows[ i ].url } );
          }
        } catch ( err ) {
          let exit_code: number = parseInt( await self.redis_client.get( 'ERR_CONTROL_CENTER_DB_ERROR' ) );
          self.logger.log_msg( 'Exception while trying to retrieve rss feeds to fetch\n' + JSON.stringify( err ), exit_code );
          await self.dbconn.end();
          exit( exit_code ); // docker will restart the container, so we'll start clean
        }
      } else {
        console.log( self.logger.get_log( 'RSS processing is paused, not all services are currently healthy' ) );
      }
    }, 1000 * parseInt( env.RSS_CHECK_INTERVAL_SECONDS ) ); // check every 60 seconds (default)
  }
}