import { ILogger } from './KeyStore/Interfaces/ILogger.js';
import { IMessageQueueSub } from './KeyStore/Interfaces/IMessageQueueSub.js';
import { Processor, Worker } from 'bullmq';
import { env } from 'node:process';

/**
 * Message queue class, responsible for retrieving messages
 * across microservices and managing jobs parallelism.
 */
export class MessageQueueSub implements IMessageQueueSub {

  /**
   * Server connection to use for this MQ instance.
   * @private
   */
  private connection: any;

  /**
   * An object containing workers that exist on the MQ.
   * These workers are named by topics of the MQ.
   *
   * @type { Object }
   * @private
   */
  private workers: { [key: string]: Array<Worker> } = {};

  /**
   * A logger class instance.
   * @type { ILogger }
   * @private
   */
  private logger: ILogger;

  /**
   * Passes the connection and logger instances to this class.
   *
   * @param { any }     connection Connection to the backend MQ server.
   * @param { ILogger } logger     Instance of the logger class.
   *
   * @constructor
   */
  constructor( connection: any, logger: ILogger ) {
    this.connection = connection;
    this.logger = logger;
  }

  /**
   * Consumes messages from the given topic and passes them
   * to the callback function provided.
   *
   * @param { string }    topic    The topic from which we want to be receiving messages with this class instance.
   * @param { Processor } callback The callback function to call when a new message arrives.
   *
   * @return Promise<Worker>
   * @public
   */
  public async consume( topic: string, callback: Processor ): Promise<Worker> {
    if ( !this.workers[ topic ] ) {
      this.workers[ topic ] = [];
    }

    let worker = new Worker(
      topic,
      callback,
      {
        connection: this.connection,
        concurrency: parseInt( env.MQ_MAX_CONCURRENCY )
      }
    );

    this.workers[ topic ].push( worker );

    return worker;
  }

}