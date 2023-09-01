import { IMessageQueuePub } from './KeyStore/Interfaces/IMessageQueuePub.js';
import { env, exit } from 'node:process';
import { CompressionTypes, Kafka, Producer } from 'kafkajs';
import { ILogger, LOG_SEVERITIES } from './KeyStore/Interfaces/ILogger.js';

/**
 * Message queue class, responsible for sending messages
 * across microservices.
 */
export class MessageQueuePub implements IMessageQueuePub {

  /**
   * Client
   * @type { Kafka }
   * @private
   */
  private client: Kafka;

  /**
   * Producer
   * @type { any }
   * @private
   */
  private producer: Producer;

  /**
   * Determines whether the Kafka client was successfully connected.
   * @type { boolean }
   * @private
   */
  private ready: boolean = false;

  /**
   * A logger class instance.
   * @type { ILogger }
   * @private
   */
  private logger: ILogger;

  /**
   * Passes the connection and logger instances to this class.
   *
   * @param { Kafka }  connection Connection to the backend MQ server.
   * @param { ILogger} logger     Instance of the logging class.
   *
   * @constructor
   */
  constructor( connection: Kafka, logger: ILogger ) {
    this.client = connection;
    this.logger = logger;

    // create a Kafka producer
    this.producer = this.client.producer({
      idempotent: true,
    });

    // connect to the producer
    this.producer.connect().then( () => {
      this.ready = true;
    }).catch( ( err ) => {
      console.log( this.logger.format( 'Exception while trying to connect to Kafka brokers (producer) ' + "\n" + JSON.stringify( err ) ) );
      exit( 1 );
    });
  }

  /**
   * Sends a message into the given topic with the given trade ID.
   *
   * @param { string } topic         The topic to send the message to.
   * @param { Object } message       The actual message object. This will be JSON-encoded before sending.
   * @param { string } trace_id      Trace ID which we can use to continue tracing the lifetime of this request
   *                                 thorough all of the microservices ecosystem.
   */
  public async send( topic: string, message: Object, trace_id: string ): Promise<void> {
    if ( this.ready ) {
      try {
        await this.producer.send({
          topic: topic,
          messages: [{ key: trace_id, value: JSON.stringify( message ) }],
          acks: -1, // must be -1 because producer is set as idempotent, i.e. each message is written exactly once
          compression: CompressionTypes.GZIP,
        });
      } catch ( err ) {
        await this.logger.log_msg( 'Error publishing feed fetch to Kafka cluster:\n' + JSON.stringify( message ) + '\nerr: ' + JSON.stringify( err ), 'ERR_CONTROL_CENTER_CANNOT_PUBLISH_FEED', LOG_SEVERITIES.LOG_SEVERITY_ERROR, { trace_id: trace_id } );
      }
    }
  }

}