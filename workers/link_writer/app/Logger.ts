import { KafkaProducer } from "./KafkaProducer.js";

/**
 * Enumeration of LOG severities.
 */
export enum LOG_SEVERITIES {

  LOG_SEVERITY_ERROR = 'error',
  LOG_SEVERITY_LOG = 'log',
  LOG_SEVERITY_NOTICE = 'notice',

}

/**
 * A logging class that formats log messages and logs them
 * into the console and the Kafka cluster.
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
   * Instance of the KafkaProducer used for message publishing
   * sections of the code.
   * @private
   * @type { KafkaProducer }
   */
  private kafka_producer: KafkaProducer = null;

  /**
   * Redis client instance.
   * @private
   * @type { any }
   */
  private redis_client: any = null;

  /**
   * Create a global logger instance and sets client ID
   * to the correct value for later logging purposes.
   *
   * @param { string }           client_id      Client ID to identify client in log messages.
   * @param { string }           service_id     Service ID to add to Redis logs.
   * @param { any }              redis_client   Redis client instance.
   * @param { KafkaClient|null } kafka_producer Kafka producer used for publishing log messages.
   * @constructor
   */
  constructor(client_id: string, service_id: string, redis_client: any = null, kafka_producer: KafkaProducer|null = null ) {
    this.client_id = client_id;
    this.service_id = service_id;
    this.redis_client = redis_client;
    this.kafka_producer = kafka_producer;
  }

  /**
   * Sets a new Kafka Producer.
   * @param { KafkaProducer } kafka_producer The Kafka Producer to use from now on.
   */
  public set_kafka_producer( kafka_producer: KafkaProducer ): void {
    this.kafka_producer = kafka_producer;
  }

  /**
   * Sets a new Redis client.
   * @param { any } redis_client The Redis client to use from now on.
   */
  public set_redis_client( redis_client: any ): void {
    this.redis_client = redis_client;
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
    return '[' + dt.getDate() + '.' + ( dt.getMonth() + 1 ) + '.' + dt.getFullYear() + ' ' + dt.getHours() + ':' + dt.getMinutes() + ':' + dt.getSeconds() + '] ' + this.client_id + ': ' + msg;

  }

  /**
   * Logs message into the console and Kafka.
   *
   * @param { string }        msg        Message to log.
   * @param { number|string } code       A numeric error code. If string is passed, code will be looked up from the Redis client.
   * @param { string }        severity   Log severity - on of the LOG_SEVERITIES enum, @see { Analysis.LOG_SEVERITIES }
   * @param { Object }        extra_data Any extra data to be passed to the message.
   */
  public async log_msg( msg: string, code: number|string = 0, severity: string = LOG_SEVERITIES.LOG_SEVERITY_ERROR, extra_data: Object = {} ): Promise<void> {
    msg = this.get_log( msg );

    if ( this.kafka_producer ) {
      let log_msg = {
        'service': this.service_id,
        'time': Math.round( Date.now() / 1000 ),
        'msg': msg,
      };

      if (severity) {
        log_msg[ 'severity' ] = severity;
      }

      if (code) {
        if ( typeof code === 'string' ) {
          log_msg[ 'code' ] = parseInt( await this.redis_client.get( code ) );
        } else {
          log_msg[ 'code' ] = code;
        }
      }

      if ( Object.keys( extra_data ) ) {
        log_msg[ 'extra_data' ] = extra_data;
      }

      // no await - we're not returning anything here
      this.kafka_producer.log_msg( log_msg );
    }
  }

}