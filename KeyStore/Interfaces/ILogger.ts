/**
 * Interface for log handling classes.
 */

import { IMessageQueuePub } from './IMessageQueuePub.js';
import { IKeyStorePub } from './IKeyStorePub.js';

/**
 * Enumeration of LOG severities.
 */
export enum LOG_SEVERITIES {

  LOG_SEVERITY_ERROR = 'error',
  LOG_SEVERITY_LOG = 'log',
  LOG_SEVERITY_NOTICE = 'notice',

}

export interface ILogger {

  /**
   * Sets a new message queue broker.
   * @param { IMessageQueuePub } mq_broker The message queue broker to use from now on.
   */
  set_mq_broker( mq_broker: IMessageQueuePub ): void;

  /**
   * Sets a new Key Store Pub client.
   * @param { IKeyStorePub } key_store_pub The Key Store Pub client to use from now on.
   */
  set_key_store_pub_client( key_store_pub: IKeyStorePub ): void;

  /**
   * Formats a log message by prefixing it with date/time and client ID.
   *
   * @param { string } msg Message to format for logging purposes.
   *
   * @return { string } Returns a correctly formatted log message.
   */
  format(msg: string): string;

  /**
   * Logs message into the message queue log.
   *
   * @param { string }        msg        Message to log.
   * @param { number|string } code       A numeric error code. If string is passed, code will be looked up from the key store client.
   *                                     Set as optional parameter here, since it will be pre-set to a general default value
   *                                     in the actual implementation.
   * @param { string }        severity   Log severity - on of the LOG_SEVERITIES enum, @see { Analysis.LOG_SEVERITIES }
   *                                     Set as optional parameter here, since it will be pre-set to a general default value
   *                                     in the actual implementation.
   * @param { Object }        extra_data Any extra data to be passed to the message.
   *                                     Set as optional parameter here, since it will be pre-set to a general default value
   *                                     in the actual implementation.
   */
  log_msg( msg: string, code?: number|string, severity?: string, extra_data?: Object ): Promise<void>;

}