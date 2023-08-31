/**
 * Interface for a publishing message queue broker.
 */
export interface IMessageQueuePub {

  /**
   * Sends message to the message queue.
   *
   * @param { string } topic    Topic to sent the message to.
   * @param { Object } msg      Message data to publish. Will be converted into a JSON string.
   * @param { string } trace_id ID of the tracing software's root span, so we can continue
   *                            tracing the request as it flows through the relevant microservices.
   *                            Will be set to a random ID if we're not logging a traceable request.
   * @return Promise<void>
   */
  send( topic: string, message: Object, trace_id: string ): Promise<any>;

}