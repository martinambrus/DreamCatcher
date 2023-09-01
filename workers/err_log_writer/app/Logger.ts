import { ILogger, LOG_SEVERITIES } from './MQ/KeyStore/Interfaces/ILogger.js';
import { IMessageQueuePub } from './MQ/KeyStore/Interfaces/IMessageQueuePub.js';
import { env } from 'node:process';
import { IKeyStorePub } from './MQ/KeyStore/Interfaces/IKeyStorePub.js';

/**
 * A logging class that formats log messages and logs them
 * into the console and the MQ.
 * @class Logger
 */
export class Logger implements ILogger {

  /**
   * Main app client ID, so we can prepend it to every log message.
   * @private
   * @type { string }
   */
  private readonly client_id: string;

  /**
   * Main app service ID, so we can use it in logs.
   * @private
   * @type { string }
   */
  private readonly service_id: string;

  /**
   * Instance of the message broker class used for message publishing.
   * @private
   * @type { IMessageQueuePub }
   */
  private mq_broker: IMessageQueuePub = null;

  /**
   * Key Store Pub client instance.
   * @private
   * @type { IKeyStorePub }
   */
  private key_store_pub: IKeyStorePub = null;

  /**
   * Logs channel name.
   * @private
   */
  private logs_channel_name: string;

  /**
   * Create a global logger instance and sets client ID
   * to the correct value for later logging purposes.
   *
   * @param { string }                client_id     Client ID to identify client in log messages.
   * @param { string }                service_id    Service ID to add to logs.
   * @param { IKeyStorePub }          key_store_pub Key Store Pub client instance, used to fetch error codes.
   * @param { IMessageQueuePub|null } mq_broker     Message broker, used for publishing log messages.
   * @constructor
   */
  constructor(client_id: string, service_id: string, key_store_pub: IKeyStorePub = null, mq_broker: IMessageQueuePub|null = null ) {
    this.client_id = client_id;
    this.service_id = service_id;
    this.key_store_pub = key_store_pub;
    this.mq_broker = mq_broker;

    this.logs_channel_name = env.LOGS_CHANNEL_NAME;
  }

  /**
   * Sets a new message broker instance.
   * @param { IMessageQueuePub } broker The message broker to use from now on.
   */
  public set_mq_broker( broker: IMessageQueuePub ): void {
    this.mq_broker = broker;
  }

  /**
   * Sets a new Key Store Pub client.
   * @param { IKeyStorePub } key_store_pub The Key Store Pub client to use from now on.
   */
  public set_key_store_pub_client( key_store_pub: IKeyStorePub ): void {
    this.key_store_pub = key_store_pub;
  }

  /**
   * Formats a log message by prefixing it with date/time and client ID.
   *
   * @param { string } msg Message to format for logging purposes.
   *
   * @return { string } Returns a correctly formatted log message.
   */
  public format(msg: string): string {
    let dt: Date = new Date();
    return '[' + dt.getDate() + '.' + ( dt.getMonth() + 1 ) + '.' + dt.getFullYear() + ' ' + dt.getHours() + ':' + dt.getMinutes() + ':' + dt.getSeconds() + '] ' + this.client_id + ': ' + msg;

  }

  /**
   * Logs message into the message queue log.
   *
   * @param { string }        msg        Message to log.
   * @param { number|string } code       A numeric error code. If string is passed, code will be looked up from the key store client.
   * @param { string }        severity   Log severity - on of the LOG_SEVERITIES enum, @see { Analysis.LOG_SEVERITIES }
   * @param { Object }        extra_data Any extra data to be passed to the message.
   */
  public async log_msg( msg: string, code: number|string = 0, severity: string = LOG_SEVERITIES.LOG_SEVERITY_ERROR, extra_data: Object = {} ): Promise<void> {
    msg = this.format( msg );

    if ( this.mq_broker ) {
      let log_msg = {
        'service': this.service_id,
        'time': Math.round( Date.now() / 1000 ),
        'msg': msg,
      };

      if (severity) {
        log_msg['severity'] = severity;
      }

      if (code) {
        if ( typeof code === 'string' ) {
          log_msg['code'] = parseInt( await this.key_store_pub.get( code ) );
        } else {
          log_msg['code'] = code;
        }
      }

      if ( Object.keys( extra_data ) ) {
        log_msg[ 'extra_data' ] = extra_data;
      }

      // extract trace ID, if found
      let msg_key = Date.now() + '_' + Math.random(); // random key if trace ID is not present
      if ( extra_data && extra_data[ 'trace_id' ] ) {
        msg_key = extra_data[ 'trace_id' ];
      }

      // no await - we're not returning anything here
      this.mq_broker.send( this.logs_channel_name, log_msg, msg_key );
    }
  }

}