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

export class LogWriter {

  /**
   * Main app client identifier
   * @private
   */
  private readonly client_id: string;

  /**
   * Main app service ID, so we can use it in Redis logs.
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
   * @param { string }      client_id        ID of the main application client, so we can determine who posted
   *                                         a new link message and don't react to our own messages
   * @param { string }      service_id       ID of the service from main application for Redis publishing purposes
   * @param { RedisClient } redis_sub_client Redis client used for subscribing to channels.
   * @param { RedisClient } redis_pub_client Redis client used to publish to Redis channels.
   * @param { Logger }      logger           A Logger class instanced used for logging purposes.
   * @param { pkg.Client }  dbconn           A PGSQL client instance.
   */
  constructor( client_id: string, service_id: string, redis_sub_client: RedisClient, redis_pub_client: RedisClient, logger: Logger, dbconn: pkg.Client ) {

    this.client_id = client_id;
    this.service_id = service_id;
    this.redis_sub_client = redis_sub_client;
    this.redis_pub_client = redis_pub_client;
    this.logger = logger;
    this.dbconn = dbconn;

    // publish info about our instance going live
    this.logger.log_msg( 'subscribing to Redis channels now', 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );

    // subscribe to logs channel and log messaged into the DB
    this.redis_sub_client.subscribe( env.REDIS_LOGS_CHANNEL, async ( msg, channel ): Promise<void> => {
      let original_msg: string = msg;
      msg = JSON.parse( msg );

      if ( msg ) {
        // try inserting the log data into the DB
        const text: string = 'INSERT INTO logs(service_id, code, severity, log_time, msg, extra) VALUES($1, $2, $3, $4, $5, $6) RETURNING id';
        let values: Array<any> = [ msg.service, ( msg.code ? msg.code : 0 ), ( msg.severity ? msg.severity : 'info' ), msg.time, msg.msg.replace( /\[[^\]]+\] /gm, '' ) ]; // remove timedate prefix from message

        // check for any extra data in the message and add it to the extra column
        let extra: Object = {};
        for ( let i in msg ) {
          if ( ![ 'service', 'code', 'severity', 'time', 'msg' ].includes( i ) ) {
            extra[ i ] = msg[ i ];
          }
        }

        values.push( JSON.stringify( extra ) );

        try {
          console.log( this.logger.get_log( 'logging: ' + original_msg ) );
          const res = await this.dbconn.query(text, values);
          if ( !res.rows.length ) {
            console.log( this.logger.get_log( 'Could not insert log into db' ) );
          }
        } catch ( err ) {
          console.log( this.logger.get_log( 'DB error while trying to insert log data:\n' + err.toString() ) );
        }
      } else {
        console.log( this.logger.get_log('Exception while trying to decode and store log data: ' + original_msg ) );
      }
    });
  }
}