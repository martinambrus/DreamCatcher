import { LOG_SEVERITIES } from "./LinkWriter.js";
import {RedisClient} from "./RedisClient.js";

/**
 * A logging class that formats log messages and logs them
 * into the console and the Redis instance.
 * @class Logger
 */
export class Logger {

  /**
   * Main app client ID, so we can prepend it to every log message.
   * @private
   * @type { string }
   */
  private readonly client_id: string;

  /**
   * Main app service ID, so we can use it in Redis logs.
   * @private
   * @type { string }
   */
  private readonly service_id: string;

  /**
   * Instance of the RedisClient used for message publishing
   * sections of the code.
   * @private
   * @type { RedisClient }
   */
  private redis_pub_client: RedisClient;

  /**
   * Create a global logger instance and sets client ID
   * to the correct value for later logging purposes.
   *
   * @param { string }           client_id        Client ID to identify client in log messages.
   * @param { string }           service_id       Service ID to add to Redis logs.
   * @param { RedisClient|null } redis_pub_client Redis client used for publishing log messages.
   * @constructor
   */
  constructor(client_id: string, service_id: string, redis_pub_client: RedisClient|null = null ) {
    this.client_id = client_id;
    this.service_id = service_id;
    this.redis_pub_client = redis_pub_client;
  }

  /**
   * Sets a new Redis publishing client.
   * @param { RedisClient } redis_pub_client The Redis publishing client to use from now on.
   */
  public set_redis_pub_client( redis_pub_client: RedisClient ): void {
    this.redis_pub_client = redis_pub_client;
  }

  /**
   * Formats a log message by prefixing it with date/time and client ID.
   *
   * @param { string } msg Message to format for logging purposes.
   *
   * @return { string } Returns a correctly formatted log message.
   */
  public get_log(msg: string): string {
    let dt: Date = new Date();
    return '[' + dt.getDate() + '.' + dt.getMonth() + '.' + dt.getFullYear() + ' ' + dt.getHours() + ':' + dt.getMinutes() + ':' + dt.getSeconds() + '] ' + this.client_id + ': ' + msg;

  }

  /**
   * Logs message into the console and Redis.
   *
   * @param { string } msg      Message to log.
   * @param { number } code     A numeric error code.
   * @param { string } severity Log severity - on of the LOG_SEVERITIES enum, @see { Analysis.LOG_SEVERITIES }
   */
  public log_msg( msg: string, code: number = 0, severity: string = LOG_SEVERITIES.LOG_SEVERITY_ERROR ): void {
    msg = this.get_log( msg );
    console.log( msg );

    if ( this.redis_pub_client ) {
      let log_msg = {
        'service': this.service_id,
        'time': Date.now(),
        'msg': msg,
      };

      if (severity) {
        log_msg['severity'] = severity;
      }

      if (code) {
        log_msg['code'] = code;
      }

      this.redis_pub_client.log_msg( log_msg );
    }
  }

}