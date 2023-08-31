import { IMessageQueuePub } from './KeyStore/Interfaces/IMessageQueuePub.js';
import { Job, Queue } from 'bullmq';
import { env } from "node:process";

/**
 * Message queue class, responsible for sending messages
 * across microservices.
 */
export class MessageQueuePub implements IMessageQueuePub {

  /**
   * Server connection to use for this MQ instance.
   * @private
   */
  private connection: any;

  /**
   * An object containing queues that exist on the MQ.
   * These queues are named by topics of the MQ.
   *
   * @type { Object }
   * @private
   */
  private queues: { [key: string]: Queue };

  /**
   * Passes the connection and logger instances to this class.
   *
   * @param { any }     connection Connection to the backend MQ server.
   *
   * @constructor
   */
  constructor( connection: any ) {
    this.connection = connection;
  }

  /**
   * Sends a message into the given topic with the given trade ID.
   *
   * @param { string } topic         The topic to send the message to.
   * @param { Object } message       The actual message object. This will be JSON-encoded before sending.
   * @param { string } trace_id      Trace ID which we can use to continue tracing the lifetime of this request
   *                                 thorough all of the microservices ecosystem.
   * @param { string } unique_job_id Optional parameters. If unique job ID is required, it can be passed here.
   *
   * @return Promise<Job> Returns a promise that resolves into a job added to the queue.
   */
  public async send( topic: string, message: Object, trace_id: string, unique_job_id: string ): Promise<Job> {

    // create a new Queue for this topic, if it does not exist yet
    if ( !this.queues[ topic ] ) {
      this.queues[ topic ] = new Queue( topic, {
        connection: this.connection,
        sharedConnection: true,
        defaultJobOptions: {
          attempts: parseInt( env.MQ_FAILED_JOBS_MAX_RETRIES ),
          backoff: {
            type: 'exponential',
            delay: parseInt( env.MQ_FAILED_JOBS_BACKOFF_SECONDS ) * 1000
          }
        }
      });
    }

    // send the message through the relevant queue
    let opts = {
      removeOnComplete: true,
      removeOnFail: {
        age: parseInt( env.MQ_FAILED_JOBS_REMOVAL_AGE_SECONDS ),
      },
    };

    if ( unique_job_id ) {
      opts[ 'jobId' ] = unique_job_id;
    }

    return this.queues[ topic ].add(
      unique_job_id ?? trace_id,
      message,
      opts
    );

  }

}