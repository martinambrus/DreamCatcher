import { env } from "node:process";
import { Logger } from "./Logger.js";
import { RedisClient } from "./RedisClient.js";
import pkg from "pg";

/**
 * Enumeration of LOG severities.
 */
export enum LOG_SEVERITIES {

  LOG_SEVERITY_ERROR = 'error',
  LOG_SEVERITY_LOG = 'log',
  LOG_SEVERITY_NOTICE = 'notice',

}

export class LinkFixDetector {

  /**
   * Instance of the Logger class.
   * @private
   * @type { Logger }
   */
  private readonly logger: Logger;

  /**
   * Instance of the RedisClient used for message publishing
   * sections of the code.
   * @private
   * @type { RedisClient }
   */
  private readonly redis_pub_client: RedisClient;

  /**
   * Instance of the RedisClient used for message subscribing
   * sections of the code.
   * @private
   * @type { RedisClient }
   */
  private readonly redis_sub_client: RedisClient;

  /**
   * PostgreSQL client class instance.
   * @private
   * @type { pkg.Client }
   */
  private readonly dbconn: pkg.Client;

  /**
   * Stores references to Redis, PGSQL and Logger classes
   * that were created outside of this main class.
   *
   * @param { RedisClient } redis_sub_client Redis client used for subscribing to channels.
   * @param { RedisClient } redis_pub_client Redis client used to publish to Redis channels.
   * @param { Logger }      logger A Logger class instanced used for logging purposes.
   * @param { pkg.Client }  dbconn A PGSQL client instance.
   */
  constructor( redis_sub_client: RedisClient, redis_pub_client: RedisClient, logger: Logger, dbconn: pkg.Client ) {

    this.redis_sub_client = redis_sub_client;
    this.redis_pub_client = redis_pub_client;
    this.logger = logger;
    this.dbconn = dbconn;

    // publish info about our instance going live
    this.logger.log_msg( 'subscribing to Redis channels now', 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );

    // subscribe to RSS new links channel, so we can update statistics for links amount per day, month and year
    // once the link writer publishes its new links counter
    this.redis_sub_client.subscribe( env.REDIS_LOGS_CHANNEL, async ( msg, channel ): Promise<void> => {
      let original_msg: string = msg;
      msg = JSON.parse( msg );

      if ( msg ) {
        // check that we have the right message
        if ( msg.service.indexOf( 'rss-fetch' ) > -1 && msg.severity == LOG_SEVERITIES.LOG_SEVERITY_NOTICE && msg.code == parseInt( await this.redis_pub_client.get( 'ERR_RSS_FETCH_WRONG_URL' ) ) ) {
          try {
            console.log( logger.get_log( 'updating feed URL for feed ' + msg.old_feed_url + ' to ' + msg.feed_url ) );
            this.dbconn.query( 'UPDATE feeds SET url = $1 WHERE url = $2', [ msg.feed_url, msg.old_feed_url ] );
          } catch ( err ) {
            logger.log_msg('Exception while trying to update feed URL for ' + msg.old_feed_url + '\n' + err.toString(), parseInt( await this.redis_pub_client.get( 'ERR_INVALID_FEED_URL_UPDATE_FAILURE' ) ) );
          }
        }
      } else {
        logger.log_msg('Exception while trying to decode log data: ' + original_msg, parseInt( await this.redis_pub_client.get( 'ERR_LOG_MESSAGE_INVALID' ) ) );
      }
    });
  }
}