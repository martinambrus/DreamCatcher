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
   * Statistical object for PGSQL prepared statements incrementing stories per day count.
   * @private
   * @type { object }
   */
  private inc_stories_per_day_query: Object = {
    name: 'inc_stories_per_day',
    text: 'SELECT inc_stories_per_day( $1, $2, $3, $4, $5 )',
  };

  /**
   * Statistical object for PGSQL prepared statements incrementing stories per month count.
   * @private
   * @type { object }
   */
  private inc_stories_per_month_query: Object = {
    name: 'inc_stories_per_month',
    text: 'SELECT inc_stories_per_month( $1, $2, $3, $4 )',
  };

  /**
   * Statistical object for PGSQL prepared statements incrementing stories per hour count.
   * @private
   * @type { object }
   */
  private inc_stories_per_hour_query: Object = {
    name: 'inc_stories_per_hour',
    text: 'SELECT inc_stories_per_hour( $1, $2, $3, $4, $5 )',
  };

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
    this.redis_sub_client.subscribe( env.REDIS_NEW_LINKS_CHANNEL, async ( msg, channel ): Promise<void> => {
      let original_msg: string = msg;
      msg = JSON.parse( msg );

      if ( msg ) {
        // check that we have the right message
        if ( msg.service.indexOf( 'link_writer' ) > -1 && typeof( msg.msg.links_count ) != 'undefined' ) {
          let dt: Date = new Date();

          try {
            this.logger.log_msg( 'writing stats data for ' + msg.msg.feed_url, 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );
            this.inc_stories_per_hour_query[ 'values' ] = [ msg.msg.feed_url, dt.getHours(), this.daysIntoYear(dt), dt.getFullYear(), msg.msg.links_count ];
            this.dbconn.query( this.inc_stories_per_hour_query );

            this.inc_stories_per_day_query[ 'values' ] = [ msg.msg.feed_url, dt.getDay(), this.weekIntoYear( dt ), dt.getFullYear(), msg.msg.links_count ];
            this.dbconn.query( this.inc_stories_per_day_query );

            this.inc_stories_per_month_query[ 'values' ] = [ msg.msg.feed_url, dt.getMonth(), dt.getFullYear(), msg.msg.links_count ];
            this.dbconn.query( this.inc_stories_per_month_query );
          } catch ( err ) {
            this.logger.log_msg('Exception while trying to save statistical feed data of ' + msg.msg.feed_url + '\n' + err.toString() + '\ndata: ' + original_msg, parseInt( await this.redis_pub_client.get( 'ERR_ANALYSIS_FEED_FREQUENCY_UPDATE_FAILURE' ) ) );
          }
        }
      } else {
        this.logger.log_msg('Exception while trying to decode Link Writer log data: ' + original_msg, parseInt( await this.redis_pub_client.get( 'ERR_LINK_WRITER_INVALID_LOG_MSG' ) ) );
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