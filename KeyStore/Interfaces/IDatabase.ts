/**
 * Interface describing database functionality.
 */
export interface IDatabase {

  /**
   * Updates all feeds with 10+ subsequent failures
   * where last fetch was more than 2 days ago.
   */
  update_old_failed_feeds(): Promise<void>;

  /**
   * Retrieves all feeds that can be presently fetched
   * and polled for new links.
   */
  fetch_feeds(): Promise<{ records: Array<{ url: string }> }>;

  /**
   * Updates old (and wrong) URL for an RSS feed with a new (and valid) one.
   *
   * @param { string } old_url The old (invalid) URL.
   * @param { string } new_url The new and valid URL.
   */
  fix_feed_url( old_url: string, new_url: string ): Promise<void>;

  /**
   * Retrieves feed ID from the URL given.
   *
   * @param { string } url The URL to look up feed ID for.
   *
   * @return { bigint } Returns feed ID for the feed URL given.
   */
  get_feed_id_from_url( url: string ): Promise<bigint>;

  /**
   * Updates feed statistics and fetch times
   * upon successfully finished RSS fetch.
   *
   * @param { string } feed_url                  URL for the feed to update statistical data for.
   * @param { number } date_hour                 Current hour.
   * @param { number } date_day_number           Number of day in week, staring at 0 for Monday.
   * @param { number } date_days_into_year       Number of days into this year.
   * @param { number } date_week_into_year       Number of weeks into this year.
   * @param { number } date_month                Current month number.
   * @param { number } date_full_year            Current full year representation.
   * @param { number } links_count               Count of all links written during the RSS fetch.
   * @param { number } first_link_unix_timestamp Timestamp of the first written RSS link's published date.
   */
  inc_stats_and_fetch_times(
    feed_url: string,
    date_hour: number,
    date_day_number: number,
    date_days_into_year: number,
    date_week_into_year: number,
    date_month: number,
    date_full_year: number,
    links_count: number,
    first_link_unix_timestamp: number
  ): Promise<void>;

  /**
   * Updates fetch times only upon unsuccessful RSS fetch.
   *
   * @param { string } feed_url URL for the feed to update statistical data for.
   * @param { string } err_msg  The error message to record for the failed RSS fetch.
   */
  inc_fetch_times_only( feed_url: string, err_msg: string ): Promise<void>;

  /**
   * Logs error received from the message queue and reported
   * by one of the other services into database.
   *
   * @param { string } service_name     Name of the service that reported the error.
   * @param { number } err_code         Error code reported. These are stored in the Key Store with their unique names.
   * @param { number } log_time_unix_ts Unix timestamp of the error.
   * @param { string } message          Error message received from the reporting service.
   * @param { string } extra_data       Any extra data to be stored with this error message.
   *                                    Provided by the reporting service.
   */
  log_error(
    service_name: string,
    err_code: number,
    log_time_unix_ts: number,
    message: string,
    extra_data: string
  ): Promise<void>;

  /**
   * Inserts new link into the database for the given feed ID.
   *
   * @param { number } feed_id             ID of the feed to which this links belongs.
   * @param { string } title               Title received for this RSS link. Can be empty.
   * @param { string } description         Description for this RSS link, received from RSS. Can be empty.
   * @param { string } link                Full URL to the article itself.
   * @param { string } image_url           Full URL to the image representing this link. Can be empty.
   * @param { number } date_posted_unix_ts Unix timestamp of the date when this link was posted.
   */
  insert_link(
    feed_id: number,
    title: string,
    description: string,
    link: string,
    image_url: string,
    date_posted_unix_ts: number
  ): Promise<void>;

}