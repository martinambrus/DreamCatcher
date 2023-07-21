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

}

export class Analysis {

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
   * Statistical object for PGSQL prepared statements updating feed stats and fetch times
   * upon successfully finished RSS fetch.
   * @private
   * @type { object }
   */
  private inc_stats_and_fetch_times: Object = {
    name: 'update_feed_data',
    text: 'SELECT update_feed_after_fetch_success( $1, $2, $3, $4, $5, $6, $7, $8, $9 )',
  };

  /**
   * Statistical object for PGSQL prepared statements updating fetch times only
   * upon unsuccessful RSS fetch.
   * @private
   * @type { object }
   */
  private inc_fetch_times_only: Object = {
    name: 'update_feed_fetch_times',
    text: 'SELECT update_feed_after_fetch_failed( $1, $2 )',
  };

  /**
   * An array of error codes loaded from Redis
   * for the RSS fetcher service. This is important
   * because we are monitoring the logs channel
   * for these errors in order to update DB fetch frequency data.
   *
   * @private
   * @type { number }
   */
  private important_rss_fetch_error_codes: Array<number> = [];

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

    let self = this;
    ( async (): Promise<void> => {
      for (let err_code_string of ['ERR_RSS_FETCH_INVALID_JSON_FEED', 'ERR_RSS_FETCH_PROCESSING', 'ERR_RSS_FETCH_TIMEOUT', 'ERR_RSS_FETCH_WRONG_URL_CANNOT_FIX']) {
        self.important_rss_fetch_error_codes.push( parseInt( await self.redis_pub_client.get( err_code_string ) ) );
      }
    })();

    // subscribe to RSS new links channel, so we can update statistics for links amount per day, month and year
    // once the link writer publishes its new links counter
    this.redis_sub_client.subscribe( env.REDIS_NEW_LINKS_CHANNEL, async ( msg, channel ): Promise<void> => {
      let original_msg: string = msg;
      msg = JSON.parse( msg );

      if ( msg ) {
        // check that we have the right message
        if ( msg.service.indexOf( 'link_writer' ) > -1 ) {
          let dt: Date = new Date();

          if ( !msg.msg.links_count ) {
            msg.msg.links_count = 0;
          }

          if ( !msg.msg.first_item_ts ) {
            msg.msg.first_item_ts = Math.round( Date.now() / 1000 );
          }

          try {
            this.logger.log_msg( 'writing stats data and updating fetch times for ' + msg.msg.feed_url, 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );
            this.inc_stats_and_fetch_times[ 'values' ] = [ msg.msg.feed_url, dt.getHours(), dt.getDay(), this.daysIntoYear(dt), this.weekIntoYear( dt ), dt.getMonth(), dt.getFullYear(), msg.msg.links_count, msg.msg.first_item_ts ];
            this.dbconn.query( this.inc_stats_and_fetch_times );
          } catch ( err ) {
            this.logger.log_msg('Exception while trying to save statistical feed data of ' + msg.msg.feed_url + '\n' + err.toString() + '\ndata: ' + original_msg, parseInt( await this.redis_pub_client.get( 'ERR_ANALYSIS_FEED_FREQUENCY_UPDATE_FAILURE' ) ) );
          }
        }
      } else {
        this.logger.log_msg('Exception while trying to decode Link Writer log data: ' + original_msg, parseInt( await this.redis_pub_client.get( 'ERR_LINK_WRITER_INVALID_LOG_MSG' ) ) );
      }
    });

    // subscribe to logs channel, so we can catch RSS feed fetcher errors for any feed
    // and update our fetch intervals accordingly
    this.redis_sub_client.subscribe( env.REDIS_LOGS_CHANNEL, async ( msg, channel ): Promise<void> => {
      let original_msg: string = msg;
      msg = JSON.parse( msg );

      if ( msg ) {
        // check that we have the right message
        if ( msg.service.indexOf( 'rss_fetch' ) > -1 && self.important_rss_fetch_error_codes.includes( parseInt( msg.code ) ) ) {
          let dt: Date = new Date();

          try {
            this.logger.log_msg( 'updating fetch times for failed fetch of ' + msg.msg.feed_url, 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );
            this.inc_fetch_times_only[ 'values' ] = [ msg.feed_url, msg.msg ];
            this.dbconn.query( this.inc_fetch_times_only );
          } catch ( err ) {
            this.logger.log_msg('Exception while trying to update feed fetch data of ' + msg.msg.feed_url + '\n' + err.toString() + '\ndata: ' + original_msg, parseInt( await this.redis_pub_client.get( 'ERR_ANALYSIS_FEED_FREQUENCY_UPDATE_FAILURE' ) ) );
          }
        }
      } else {
        this.logger.log_msg('Exception while trying to decode RSS fetch log data: ' + original_msg, parseInt( await this.redis_pub_client.get( 'ERR_RSS_FETCH_INVALID_LOG_MSG' ) ) );
      }
    });
  }

  /**
   * Returns the number of current day in the given date's year.
   *
   * @param   { Date } date The date from which to calculate the day number.
   * @private
   *
   * @return { number } Returns the number of current day in this year.
   */
  private daysIntoYear( date: globalThis.Date ): number {
    return ( Date.UTC( date.getFullYear(), date.getMonth(), date.getDate() ) - Date.UTC( date.getFullYear(), 0, 0 ) ) / 24 / 60 / 60 / 1000;
  }

  /**
   * Returns number of week into the given date's year.
   *
   * @param { Date } date Date from which to calculate number of weeks.
   * @private
   *
   * @return Returns number of week into the given date's year.
   */
  private weekIntoYear( date: globalThis.Date ): number {
    date.setHours(0, 0, 0, 0);

    // Thursday in current week decides the year.
    date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);

    // January 4 is always in week 1.
    let week1: Date = new Date(date.getFullYear(), 0, 4);

    // Adjust to Thursday in week 1 and count number of weeks from date to week1.
    return 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
  }
}