<?php
namespace martinambrus;
use JDecool\JsonFeed\Reader\ReaderBuilder;

/**
 * @LOG_SEVERITIES Enumeration of LOG severities.
 */
enum LOG_SEVERITIES: string {

  case LOG_SEVERITY_ERROR = 'error';
  case LOG_SEVERITY_NOTICE = 'notice';

  case LOG_SEVERITY_LOG = 'log';

}

/**
 * The main RSS fetching class, utilizing SimplePie, cURL
 * and JSON Reader functions to get and parse an RSS feed.
 */
class RSSFetcher {

  /**
   * @const Default feed URL to test RSS parsing. Used when in test mode (i.e. first run). Set to Hacker News feed.
   */
  private string $DEFAULT_TEST_FEED_URL = 'https://news.ycombinator.com/rss'; // valid feed
  //private string $DEFAULT_TEST_FEED_URL = 'news.ycombinator.com/rss'; // non-prefixed feed
  //private string $DEFAULT_TEST_FEED_URL = 'https://decisions.ipc.on.ca/ipc-cipvp/phipa/en/json/rss.do'; // json feed

  /**
   * @var string Holds original feed URL to use in case test mode was turned on and then back off.
   */
  private string $original_feed_url = '';

  /**
   * @var bool $test_run Whether or not this is the first (test) run of the RSS Fetcher, in which case
   *                     we'll simply try out Redis and DB connections and RSS parsing of a default feed and exit.
   */
  private bool $test_run = false;

  /**
   * @var bool Whether or not the RSS was successfully fetched and parsed.
   *           Used in the shutdown function, so we know whether to report a timeout error while getting/parsing
   *           a feed when the script timeout occurs.
   */
  private bool $fetch_complete = false;

  /**
   * @var string Client instance identification. Normally provided via the HOSTNAME environment variable.
   *             Used for Redis log messages.
   */
  private string $client_id = 'rss_fetch_undefined_host';

  /**
   * @var string ID of this service type. Used for Redis messages.
   */
  private string $service_id = 'rss-fetch';

  /**
   * @var string The RSS feed url to retrieve and parse.
   */
  private string $feed_url;

  /**
   * @var Redis Redis publishing client instance.
   */
  private Redis $redis_pub;

  /**
   * Sets some internal parameters.
   *
   * @param string $feed_url  Feed URL to parse and process.
   * @param string $client_id ID of this client - used for logging purposes.
   * @param Redis  $redis_pub Redis class instance, used to publish logs, errors and new links
   *                          to the infrastructure.
   */
  public function __construct( string $feed_url, string $client_id, Redis $redis_pub ) {
    $this->feed_url = $feed_url;

    // leave the default client ID if we did not receive a valid value
    // (i.e. environment variable is not set etc.)
    if ( $this->client_id ) {
      $this->client_id = $client_id;
    }

    $this->redis_pub = $redis_pub;
  }

  /**
   * Parses the current feed, sending link items over Redis for further processing.
   *
   * @return void
   */
  public function parse():void {
    global $time_start;

    // check if we have a feed URL
    if ( !$this->feed_url && !$this->test_run ) {
      $this->log_msg( 'error: no feed URL passed in ENV variable for rss-fetch', 'ERR_RSS_FETCH_NO_FEED' );

      $this->fetch_complete = true;
      exit();
    }

    // make sure that the feed URL has a valid protocol prefix
    $this->fix_feed_prefix();

    try {
      // fetch the URL via cURL
      $data = $this->fetch_url( $this->feed_url );

      // if an error occured while fetching...
      if (is_array($data)) {
        // throwing here would move us to the catch block with error handling
        throw new \Exception( $data[0] );
      }

      // check that this is not a JSON feed
      $json = json_decode( $data );
      if ($json !== null) {
        // we have a JSON feed - it can still be set to false
        if ($json !== false) {
          $builder = new ReaderBuilder();
          $reader = $builder->build();
          $feed = $reader->createFromJson( $data );

          $this->process_json_feed( $feed );
        } else {
          // invalid JSON feed detected, log error and exit
          $this->log_msg(
            'invalid (unparsable) JSON feed ( ' . $this->feed_url . ' ) detected, body was: ' . $data,
            'ERR_RSS_FETCH_INVALID_JSON_FEED'
          );

          // set this to true, so we know we've not reached a script timeout
          $this->fetch_complete = true;
          exit();
        }
      } else {
        // we have a XML feed
        $feed = $this->parse_feed(null, $data);

        if ($feed->error()) {
          // throwing here would move us to the catch block with error handling
          throw new \Exception( $feed->error() );
        }

        // reverse feed items, so they are sorted from the oldest one to the newest
        $items = array_reverse( $feed->get_items() );

        // process items
        $this->process_xml_feed( $items );
      }
    } catch (\Exception $exception) {
      try {
        $this->log_msg(
          '(' . $exception->getCode() . ') Error processing "' . $this->feed_url . '" with message: ' . $exception->getMessage() . ' (file ' . $exception->getFile() . ', line ' . $exception->getLine() . ')',
          'ERR_RSS_FETCH_PROCESSING',
        );
      } catch ( \Exception $e ) {
        echo "\n[" . gmdate( 'j.m.Y H:i:s' ) . '] Additional exception found while trying to publish error log to Redis (' . getenv('REDIS_HOSTNAME') . ':' . getenv('REDIS_PORT') . ")\n" . $e->getMessage() . ' in ' . $e->getFile() . ' on line ' . $e->getLine();
      } finally {
        // set this to true, so we know we've not reached a script timeout
        $this->fetch_complete = true;
      }

      exit;
    }

    $log_msg = 'fetch complete for ' . $this->feed_url . ' via ' . $this->client_id . ' in ' . (round(microtime(true) - $time_start,3) * 1000) . 'ms';
    if ( $this->test_run ) {
      $log_msg .= ', initial test run finished.';
    }

    // don't publish into log if we're on a test run, so we don't mess up statistics
    if ( $this->test_run ) {
      echo $log_msg;
    } else {
      $this->log_msg( $log_msg, 0, LOG_SEVERITIES::LOG_SEVERITY_LOG->value );
    }
  }

  /**
   * Shutdown function for the script. Used in register_shutdown_function() in app.php, so we can log script timeout into Redis.
   *
   * @return void
   */
  public function shutdown():void {
    if ( !$this->fetch_complete ) {
      $this->log_msg( 'could not fetch RSS data in ' . MAX_TIMEOUT . ' seconds for ' . $this->feed_url, 'ERR_RSS_FETCH_TIMEOUT' );
    }
  }

  /**
   * Setter. Will set the $test_run parameter.
   *
   * @param bool $value         The value to which $test_run parameter should be set.
   * @param bool $sleep_if_test If the test value is se to true, we will sleep for 5 seconds,
   *                            so we can be sure that our Redis and DB instances are up when we need
   *                            to connect to them.
   *                            TODO: revisit this if switching to Swarm / AWS and set this up to handle these cases
   *
   * @return void
   */
  public function set_test_run( bool $value, bool $sleep_if_test = true ):void {
    $this->test_run = $value;

    // if test run is on, let's set the feed URL to the default one for testing purposes
    if ( $value ) {
      // save the original feed URL in case we'll switch back later
      $this->original_feed_url = $this->feed_url;
      $this->feed_url = $this->DEFAULT_TEST_FEED_URL;
    } else {
      // set the feed url to a previously stored original URL, if we have one
      if ( $this->original_feed_url ) {
        $this->feed_url = $this->original_feed_url;
      }
    }

    // sleep for 5 seconds to allow Redis + DB to start
    if ( $sleep_if_test ) {
      sleep( 5 );
    }
  }

  /**
   * Iterates over all XML feed items and assembles their data,
   * subsequently calling a method to publish each feed item via Redis.
   *
   * @param array $items Feed items to process and assemble data from.
   *
   * @return void
   */
  private function process_xml_feed( array $items ):void {
    foreach ($items as $item) {
      // try to extract link image
      $link_img = '';

      // thumbnail found
      if ( $item->get_thumbnail() ) {
        $link_img = $item->get_thumbnail()['url'];
      } else if ( $item->get_enclosures()[0]->thumbnails && count( $item->get_enclosures()[0]->thumbnails ) ) {
        // thumbnail found but not recognized by SimplePie (YouTube)
        $link_img = $item->get_enclosures()[0]->thumbnails[0];
      } else if ( $item->get_enclosures()[0]->link ) {
        // feeds usually provide thumbnails in the link enclosure
        // let's do a super-simple educated guess here
        $image_extensions = array(
          '.jpg',
          '.jpeg',
          '.gif',
          '.png',
          '.bmp',
          '.tif',
          '.tiff'
        );

        if ( in_array( strtolower( strrchr( $item->get_enclosures()[0]->link, '.' ) ), $image_extensions ) ) {
          $link_img = $item->get_enclosures()[0]->link;
        }
      } else {
        // check if we can find image in the description
        preg_match_all( '/<img src=["\']([^"\']+)["\'][^>]*>/mi', $item->get_description(), $matches, PREG_SET_ORDER, 0 );
        if ( count( $matches ) ) {
          // use the first available image
          $link_img = $matches[0][1];
        }
      }

      $categories = [];
      if ( $item->get_categories() ) {
        foreach ( $item->get_categories() as $category ) {
          // check where our title resides
          $title = ( $category->get_label() ? $category->get_label() : $category->get_term() );

          // add category only if a title was actually found
          if ( $title ) {
            $categories[] = $title;
          }
        }
      }

      $authors = [];
      if ( $item->get_authors() ) {
        foreach ( $item->get_authors() as $author ) {
          $name = $author->get_name();
          // if name is empty, the name could contain an e-mail, in which case, author's name goes into e-mail
          if ( ! $name ) {
            $name = $author->get_email();
          }

          // remove entity tags from author names (http://export.arxiv.org/rss/astro-ph has them stored that way)
          $name = $this->untagize( $name );

          if ( $name ) {
            $authors[] = $name;
          }
        }
      }

      $feed_item_info = [
        'title'        => ($item->get_title() ? $this->untagize( $item->get_title() ) : $item->get_link()),
        'description'  => $item->get_description(),
        'link'         => $item->get_link(),
        'img'          => $link_img,
        'date'         => ( $item->get_date() ? strtotime( $item->get_date() ) : time() ),
      ];

      if ( count( $authors ) ) {
        $feed_item_info['authors'] = $authors;
      }

      if ( count( $categories ) ) {
        $feed_item_info['categories'] = $categories;
      }

      $this->publish_new_link_data( $feed_item_info );
    }
  }

  /**
   * Iterates over all JSON feed items and assembles their data,
   * subsequently calling a method to publish each feed item via Redis.
   *
   * @param \JDecool\JsonFeed\Feed $feed The actual JSON Feed object to iterate and process.
   *
   * @return void
   */
  private function process_json_feed( \JDecool\JsonFeed\Feed $feed ):void {
    foreach ( $feed->getItems() as $item ) {
      // try to extract link image
      $link_img = '';

      if ($item->getImage()) {
        $link_img = $item->getImage();
      } else if ($item->getBannerImage()) {
        $link_img = $item->getBannerImage();
      } else if ($item->getContentHtml()) {
        // check if we can find image in the description
        preg_match_all( '/<img src=["\']([^"\']+)["\'][^>]*>/mi', $item->getContentHtml(), $matches, PREG_SET_ORDER, 0 );
        if ( count( $matches ) ) {
          // use the first available image
          $link_img = $matches[0][1];
        }
      }

      $categories = [];
      if ($item->getTags()) {
        foreach ($item->getTags() as $tag) {
          $categories[] = $tag;
        }
      }

      $author = '';
      if ($item->getAuthor()) {
        if (is_string( $item->getAuthor() )) {
          $author = $item->getAuthor();
        } else if (is_array( $item->getAuthor() )) {
          $author = $item->getAuthor()[0];
        }
      }

      // use current timestamp if we can't find a date
      $date = time();
      if ($item->getDateModified()) {
        $date = $item->getDateModified()->getTimestamp();
      } else if ($item->getDatePublished()) {
        $date = $item->getDatePublished()->getTimestamp();
      }

      $description = $item->getSummary();
      // URL is optional for a JSON feed, so just use ID as a hash
      $url = ($item->getUrl() ?? '#' . $item->getId());

      $feed_item_info = [
        'title'       => ($item->getTitle() ?? $url),
        'description' => $description,
        'link'        => $url,
        'img'         => $link_img,
        'date'        => (is_int($date) ? $date : strtotime( $date )),
      ];

      if ( $author ) {
        $feed_item_info['author'] = $author;
      }

      if ( count( $categories ) ) {
        $feed_item_info['categories'] = $categories;
      }

      $this->publish_new_link_data( $feed_item_info );
    }
  }

  /**
   * Publishes new feed link data via Redis.
   *
   * @param array $link_data Link data to be published.
   *
   * @return void
   */
  private function publish_new_link_data( array $link_data ):void {
    // add feed URL and service info
    $link_data[ 'feed_url' ] = $this->feed_url;
    $link_data[ 'service' ] = $this->service_id;

    // publish
    $this->redis_pub->pub_link( $link_data );

    // mark fetch as OK, so the shutdown error handler doesn't think we've timed out
    $this->fetch_complete = true;
  }

  /**
   * Fixes a potentially invalid feed URL which doesn't have a URL protocol.
   * This method adjusts that $feed_url parameter to the correct feed URL, if a working one was found.
   *
   * @return void
   */
  private function fix_feed_prefix():void {
    // if our feed doesn't have an HTTP or HTTPS prefix, try looking for a working link with one of those prefixes
    // and update it if found
    if ( mb_strtolower( mb_substr( $this->feed_url, 0, 7)) != 'http://' && mb_strtolower( mb_substr( $this->feed_url, 0, 8)) != 'https://' ) {
      // try HTTPS first
      $file_headers = @get_headers( 'https://' . $this->feed_url );
      if ( $file_headers && !str_contains($file_headers[0], '404 Not Found')) {
        $msg = 'changing invalid feed url ' . $this->feed_url . ' to ' . 'https://' . $this->feed_url;
        $this->feed_url = 'https://' . $this->feed_url;

        // wait a moment before requesting that URL again to prevent being rate-limited
        sleep( 4 );
      } else {
        // try HTTP
        $file_headers = @get_headers( 'http://' . $this->feed_url );
        if ( $file_headers && !str_contains($file_headers[0], '404 Not Found')) {
          $msg = 'changing invalid feed url ' . $this->feed_url . ' to ' . 'http://' . $this->feed_url;
          $this->feed_url = 'http://' . $this->feed_url;

          // wait a moment before requesting that URL again to prevent being rate-limited
          sleep( 4 );
        } else {
          $this->log_msg( 'invalid feed url, unable to parse or fix: ' . $this->feed_url, 'ERR_RSS_FETCH_WRONG_URL_CANNOT_FIX' );

          // set this to true, so we know we've not reached a script timeout
          $this->fetch_complete = true;
          exit;
        }
      }

      $this->log_msg( $msg, 'ERR_RSS_FETCH_WRONG_URL', LOG_SEVERITIES::LOG_SEVERITY_NOTICE->value );
    }
  }

  /**
   * Retrieves the given URL by using cURL.
   *
   * @param string $url     The URL to retrieve.
   * @param int    $timeout Fetch timeout (in seconds).
   *
   * @return string|array Returns full body of the URL or an array with first element set to curl_error() value
   *                      if an error occurs in cURL.
   */
  private function fetch_url( string $url, int $timeout = 10 ):string|array {
    $fp = curl_init();
    curl_setopt($fp, CURLOPT_RETURNTRANSFER, 1);
    curl_setopt($fp, CURLOPT_FAILONERROR, 1);
    curl_setopt($fp, CURLOPT_TIMEOUT, $timeout);
    curl_setopt($fp, CURLOPT_CONNECTTIMEOUT, $timeout);
    //curl_setopt($fp, CURLOPT_VERBOSE, 1);
    curl_setopt($fp, CURLOPT_HEADER, 1);
    curl_setopt($fp, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($fp, CURLOPT_MAXREDIRS, 10);
    curl_setopt($fp,  CURLOPT_CUSTOMREQUEST, 'GET');
    curl_setopt($fp, CURLOPT_ENCODING, '');
    curl_setopt($fp, CURLOPT_URL, $url);
    curl_setopt($fp, CURLOPT_REFERER, $url);
    curl_setopt($fp, CURLOPT_USERAGENT, 'DreamCatcher 0.1a');
    curl_setopt($fp, CURLOPT_SSL_VERIFYHOST, 0);
    curl_setopt($fp, CURLOPT_SSL_VERIFYPEER, false);

    $headers = array();
    $headers[] = 'Pragma: ';
    $headers[] = 'Accept-Language: en-us,en;q=0.5';
    $headers[] = 'Accept-Charset: ISO-8859-1,utf-8;q=0.7,*;q=0.7';
    $headers[] = 'Keep-Alive: 300';
    $headers[] = 'Connection: keep-alive';
    $headers[] = 'Accept: */*';
    $headers[] = 'Cache-Control: max-age=0';
    $headers[] = 'Expect:';
    curl_setopt($fp,  CURLOPT_HTTPHEADER, $headers);

    $result = curl_exec($fp);
    $curl_info = curl_getinfo($fp);
    if (curl_errno($fp) === 23 || curl_errno($fp) === 61) {
      curl_setopt($fp, CURLOPT_ENCODING, 'none');
      $result = curl_exec($fp);
    }

    if (curl_errno($fp)) {
      return [ curl_error($fp) ];
    } else {
      curl_close($fp);

      // return header-less response
      $header_size = $curl_info["header_size"];
      // $header = substr($result, 0, $header_size);
      $body = substr($result, $header_size);

      return $this->clean_feed( $body );
    }
  }

  /**
   * Cleans the feed of all <content> tags which usually cause invalid and unparsable XML.
   *
   * @param string $body The actual feed body to clean up.
   *
   * @return string Returns the cleaned-up feed body.
   */
  private function clean_feed( string $body ):string {
    // remove content tags, as they usually cause invalid unparsable XML
    return preg_replace('/(?s)<[\s\/]*content[^>]*>.*?<\/content[^>]*>/mi', '', $body);
  }

  /**
   * Parses the actual feed body by using SimplePie.
   *
   * @param string|null $url      The URL or direct feed body to parse.
   * @param string|bool $raw_data Either full raw XML data of a feed that we got from elsewhere or false if $url is set.
   *
   * @return \SimplePie Returns a \SimplePie instance with parsed feed data.
   */
  private function parse_feed( string|null $url, string|bool $raw_data = false ):\SimplePie {
    // if we have clear data passed, try to clean it up
    if ($raw_data !== false) {
      $raw_data = $this->clean_feed( $raw_data );
    }

    // try a discovery of feeds using SimplePie
    $feed = new \SimplePie();
    $feed->set_useragent('DreamCatcher 0.1a'); // resolves FeedBurner's issues
    $feed->set_curl_options([
      CURLOPT_SSL_VERIFYHOST => 0,
      CURLOPT_SSL_VERIFYPEER => false,
    ]);
    $feed->enable_cache( false );
    $feed->enable_order_by_date( true );

    if ($raw_data === false) {
      $feed->set_feed_url( $url );
    } else {
      $feed->set_raw_data( $raw_data );
    }

    //$success = $feed->init();
    $feed->init();
    $feed->handle_content_type();

    return $feed;
  }

  /**
   * Removes all HTML tags from the input string. This method, additional to strip_tags() also
   * utilizes html_entity_decode() and entities to unicode characters conversion routines,
   * so the resulting text is a as valid tag-less text representation of the input as possible.
   *
   * @param string $txt The text to remove tags from.
   *
   * @return string Returns a text with all HTML tags removed and special characters converted from HTML to unicode.
   */
  private function untagize( string $txt ):string {
    // decode all HTML entities, so &gt; becomes > and we can remove tags in the next step
    $txt = html_entity_decode( $txt, ENT_QUOTES || ENT_HTML5, "UTF-8" );

    // remove all HTML tags
    $txt = strip_tags( $txt );

    //  convert all special unicode entities (&#39;) into their ASCII representation (')
    $txt = $this->entities_to_unicode( $txt );

    return $txt;
  }

  /**
   * Converts all HTML-encoded entities (such as &#39; etc.) to their unicode representation.
   *
   * @param string $str The text in which to convert HTML entities to unicode.
   *
   * @return string Returns text with all HTML-encoded entities converted to unicode.
   */
  private function entities_to_unicode( string $str ):string {
    $str = html_entity_decode($str, ENT_QUOTES, 'UTF-8');
    $str = preg_replace_callback("/(&#[0-9]+;)/", function($m) { return mb_convert_encoding($m[1], "UTF-8", "HTML-ENTITIES"); }, $str);
    return $str;
  }

  /**
   * Logs error/status messages into console and Redis, if available.
   *
   * @param string $msg The actual message to log.
   *
   * @return void
   */
  private function log_msg( string $msg, string $code = '', string $severity = LOG_SEVERITIES::LOG_SEVERITY_ERROR->value ):void {
    $msg = '[' . gmdate( 'j.m.Y H:i:s' ) . '] ' . $msg;
    echo $msg . "\n";

    $log = [
      'service' => $this->service_id,
      'time' => time(),
      'feed_url' => $this->feed_url,
      'msg' => $msg,
    ];

    if ( $severity ) {
      $log[ 'severity' ] = $severity;
    }

    // load the error code from Redis
    if ( $code ) {
      $log[ 'code' ] = $this->redis_pub->get( $code );
    }

    $this->redis_pub->log_msg( $log );
  }

}