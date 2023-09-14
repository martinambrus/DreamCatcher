/**
 * Interface for a subscribing message queue broker.
 */
export interface IMessageQueueSub {

  /**
   * Consumes messages from the given topic and passes them
   * to the callback function provided.
   *
   * @param { string|Array<string> } topic    The topic(s) from which we want to be receiving messages with this class instance.
   * @param { any }                  callback The callback function to call when a new message arrives.
   * @return Promise<any>
   * @public
   */
  consume( topic: string|Array<string>, callback: any ): Promise<any>;

}