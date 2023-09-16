/**
 * Interface for a publishing message queue broker.
 */
export interface IMessageQueuePub {

  /**
   * Sends message to the message queue.
   *
   * @param { string } topic         Topic to sent the message to.
   * @param { Object } msg           Message data to publish. Will be converted into a JSON string.
   * @param { string } trace_id      ID of the tracing software's root span, so we can continue
   *                                 tracing the request as it flows through the relevant microservices.
   *                                 Will be set to a random ID if we're not logging a traceable request.
   * @param { string } unique_job_id Optional parameters. If unique job ID is required, it can be passed here.
   *
   * @return Promise<any>
   */
  send( topic: string, message: Object, trace_id: string, unique_job_id?: string ): Promise<any>;

  /**
   * Returns TRUE if the publisher is in a batch mode, FALSE otherwise.
   */
  is_batch_mode(): boolean;

  /**
   * Sets whether this publisher should be in batch mode or not.
   *
   * @param { boolean } in_batch_mode If true, the publisher will be set to batch mode.
   *                                  If false, the publisher will exit the batch (if it was in one)
   *                                  and will immediately send out all queued messages.
   */
  set_batch_mode( in_batch_mode: boolean ): void;

  /**
   * Returns the maximum number of items to be sent at once in a single batch.
   */
  get_batch_max_items(): number;

  /**
   * Sets the maximum number of items to be sent at once in a single batch.
   *
   * @param { number } max_items Maximum number of items to be sent at once in a single batch.
   */
  set_batch_max_items( max_items: number ): void;
}