/**
 * Interface for a subscribing message queue broker.
 */
export interface IMessageQueueSub {

  /**
   * Consumes messages from the given topic and passes them
   * to the callback function provided.
   *
   * @param { string }   topic    The topic from which we want to be receiving messages with this class instance.
   * @param { Function } callback The callback function to call when a new message arrives.
   * @return void
   * @public
   */
  consume( topic: string, callback: Function ): Promise<any>;

}