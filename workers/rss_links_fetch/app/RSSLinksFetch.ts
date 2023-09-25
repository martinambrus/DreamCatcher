import { env, exit } from "node:process";
import * as http from 'node:http';
import * as https from 'node:https';
import CacheableLookup from 'cacheable-lookup';
import fetch from 'node-fetch';
import { Telemetry } from './Telemetry.js';
import { IKeyStorePub } from './Utils/MQ/KeyStore/Interfaces/IKeyStorePub.js';
import { ILogger, LOG_SEVERITIES } from './Utils/MQ/KeyStore/Interfaces/ILogger.js';
import { IMessageQueueSub } from './Utils/MQ/KeyStore/Interfaces/IMessageQueueSub.js';
import { IDatabase } from './Utils/MQ/KeyStore/Interfaces/IDatabase.js';
import { queue } from 'async';
import { JSDOM } from 'jsdom';
import { Utils } from './Utils/Utils.js';
import { IMessageQueuePub } from './Utils/Database/Interfaces/IMessageQueuePub.js';
import jquery from 'jquery';
import * as dfel from 'detect-file-encoding-and-language';
const languageEncoding = dfel.default;
const cacheable: CacheableLookup = new CacheableLookup();
const dom = new JSDOM('');
const $ = jquery( dom.window );

export class RSSLinksFetch {

  /**
   * Current version of this service.
   * Must be changed for each production-ready release.
   * @private
   * @type { string }
   */
  private readonly version: string = '0.1a';

  /**
   * Instance of the Logger class.
   * @private
   * @type { ILogger }
   */
  private readonly logger: ILogger;

  /**
   * Instance of the MQ Consumer used to listen
   * for RSS feeds to parse.
   * @private
   * @type { IMessageQueueSub }
   */
  private readonly mq_consumer: IMessageQueueSub;

  /**
   * Key store publisher and getter client instance,
   * used to fetch error codes.
   * @type { IKeyStorePub }
   * @private
   */
  private readonly key_store_pub: IKeyStorePub;

  /**
   * PostgreSQL client class instance.
   * @private
   * @type { IDatabase }
   */
  private readonly dbconn: IDatabase;

  /**
   * Name of the service, used in key store heartbeat updates.
   * @private
   * @type { string }
   */
  private readonly service_name: string;

  /**
   * Local HTTP agent to be used in node-fetch module.
   * @private
   * @type { http.Agent }
   */
  private readonly http_agent: http.Agent;

  /**
   * Local HTTPS agent to be used in node-fetch module.
   * @private
   * @type { https.Agent }
   */
  private readonly https_agent: https.Agent;

  /**
   * Queue object from the async library.
   * Used for parallel job processing.
   *
   * @private
   * @type { queue }
   */
  private readonly queue: queue;

  /**
   * A retry queue for failed link fetches.
   *
   * @private
   * @type Object
   */
  private retries: {[k: string] : { retries: number, callback: any } } = {};

  /**
   * Maximum number of retries for a single link before we abandon trying to fetch it.
   * @private
   * @type { number }
   */
  private max_retries: number = 5;

  /**
   * Name of a set that holds backup of queued links,
   * so we can retry then in case of an app crash.
   * @private
   * @type { string }
   */
  private key_value_queue_backup_set_name: string;

  /**
   * Stores references to key store, PGSQL and Logger classes
   * that were created outside of this main class.
   * Also creates instances of XML and JSON parser internal classes.
   *
   * @param { IMessageQueuePub } mq_producer   MQ Producer, used to initialize the Utils class.
   * @param { IMessageQueueSub } mq_consumer   MQ Consumer used to listen for RSS feeds to parse.
   * @param { ILogger }          logger        A Logger class instanced used for logging purposes.
   * @param { string }           service_name  ID of the service from main application for key store publishing purposes
   * @param { IKeyStorePub }     key_store_pub A Key Store Pub client to fetch error codes.
   * @param { IDatabase }        dbconn        A Database class instance.
   */
  constructor( mq_producer: IMessageQueuePub, mq_consumer: IMessageQueueSub, logger: ILogger, service_name: string, key_store_pub: IKeyStorePub, dbconn: IDatabase ) {
    // initialize http+s agents
    this.http_agent = new http.Agent({
      keepAlive: true,
    });

    this.https_agent = new https.Agent({
      keepAlive: true,
      rejectUnauthorized: false,
    });

    // install DNS cache for all HTTP and HTTPS requests globally
    cacheable.install( this.http_agent );
    cacheable.install( this.https_agent );

    // Utilities class init
    Utils.service_name = service_name;
    Utils.dbconn = dbconn;
    Utils.logger = logger;
    Utils.mq_producer = mq_producer;

    // MQ
    this.mq_consumer = mq_consumer;

    // Logger
    this.logger = logger;

    // Database
    this.dbconn = dbconn;

    // key store
    this.key_store_pub = key_store_pub;

    // strings
    this.service_name = service_name;
    this.key_value_queue_backup_set_name = ( env.RSS_LINKS_FETCH_QUEUE_SET_NAME ? env.RSS_LINKS_FETCH_QUEUE_SET_NAME : 'rss_links_queue_backup' );
    this.max_retries = ( env.RSS_MAX_FETCH_LINK_FAIL_RETRIES ? parseInt( env.RSS_MAX_FETCH_LINK_FAIL_RETRIES ) : this.max_retries );

    // prefix redis queue backup set name with current app's hostname, which is unique
    // ... this is so multiple link fetchers will not store their queue backups into the same queue
    //     and potentially start working on same tasks if they both go down at the same time
    this.key_value_queue_backup_set_name = ( env.HOSTNAME ? 'rss_links_fetch_' + env.HOSTNAME : 'rss_links_fetch_undefined_host' ) + this.key_value_queue_backup_set_name;

    // create a new async queue to process links in parallel
    this.queue = new queue( ( task, callback ) => {
      callback();
    }, ( env.RSS_MAX_FETCH_LINKS_IN_PARALLEL ? env.RSS_MAX_FETCH_LINKS_IN_PARALLEL : 25 ) );

    this.queue.error( ( err, task ) => {
      this.logger.log_msg( 'Error while trying to run task ' + task + ': ' + JSON.stringify( err ), 'ERR_RSS_LINK_FETCH_TASK_ERROR' );
    });

    // publish info about our instance going live
    this.logger.log_msg( 'rss_links_fetch up and running', 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );

    let self = this;

    // create a task that will update this service active status every minute
    // ... this is here in case Redis goes down, so we can show that we are alive again
    setInterval( (): void => {
      self.key_store_pub.set( self.service_name + '_active', 1 );
    }, 60000 );

    // subscribe to receive RSS feed links to be parsed
    this.mq_consumer.consume( env.SAVED_LINKS_CHANNEL_NAME, self.enqueue_link_html_getting.bind( this ) );

    // start a retry queue timed task
    // ... also drain the MQ Producer every 60 seconds, since we may have links data in a half-empty batch
    //     that are just waiting to be sent out and processed
    setInterval( async () => {
      for ( let item in self.retries ) {
        if ( self.retries[ item ].retries < self.max_retries ) {
          await self.retries[ item ].callback();
        } else {
          await self.logger.log_msg( 'Exhausted number of retries for link: ' + item );
          delete self.retries[ item ];
        }
      }

      // send any waiting non-full batches with links to be processed
      Utils.mq_producer.drain_batch();
    }, 60000 );

    // retry failed DB saves if the app previously crashed
    this.key_store_pub.smembers( this.key_value_queue_backup_set_name ).then( ( jobs ) => {
      if ( jobs.length ) {
        console.log( this.logger.format('resuming ' + jobs.length + ' redis-saved jobs from the previous queue') );
      }

      for ( let job of jobs ) {
        const job_data = JSON.parse( job );
        this.enqueue_link_html_getting( { topic: env.SAVED_LINKS_CHANNEL_NAME, message: job_data.message, trace_id: job_data.trace_id } );
      }
    });
  }

  /**
   * Enqueues a message from MQ to starts parsing it whenever its time in the job queue comes.
   *
   * @param { Object } data This is the processed data received from Kafka consumer.
   *                        Object structure: topic, message, trace_id
   * @private
   */
  private async enqueue_link_html_getting( { topic, message, trace_id } ): Promise<any> {
    let
      mq_message_data = message,
      mq_key_data: string = trace_id,
      trace_carrier: Object = JSON.parse( mq_key_data ),
      analysis_telemetry: Telemetry = await new Telemetry( this.service_name, this.version, mq_message_data.url ).start( trace_carrier );

    if ( !mq_message_data.link ) {
      // invalid message from the link writer
      await this.logger.log_msg( 'Error parsing link writer link data:  ' + JSON.stringify( mq_message_data ), 'ERR_RSS_LINK_FETCH_PROCESSING', LOG_SEVERITIES.LOG_SEVERITY_ERROR, { feed_url: mq_message_data.url } );
    } else {
      // check that this is not a YouTube link, in which case we'll skip it, since YT is heavily JS-based
      // and will have the same footer fixed text for each YT link
      if ( mq_message_data.link.indexOf('youtube.com/') == -1 && mq_message_data.link.indexOf('youtu.be/') == -1 && mq_message_data.link.substring( 0, 1 ) != '#' ) {
        // save this job in case we need to retry the queue later
        await this.key_store_pub.sadd( this.key_value_queue_backup_set_name, JSON.stringify( { message: message, trace_id: trace_id } ) );

        //console.log( 'adding to queue: ' + mq_message_data.link );

        this.queue.push( { name: mq_message_data.link }, async () => {
          this.parse_link_url( mq_message_data, analysis_telemetry, mq_key_data );
        });
      }
    }
  }

  /**
   * This method will try to detect a main content container on the link page
   * and extract only relevant HTML data that way. If it cannot detect a content container,
   * it will store HTML of the whole page.
   *
   * @param { any }       mq_message_data    The original message as received from MQ and parsed into an object.
   * @param { Telemetry } analysis_telemetry Telemetry object to use for tracing purposes.
   * @param { string }    trace_id           Trace ID for the Telemetry request chain.
   * @private
   */
  private async parse_link_url( mq_message_data: any, analysis_telemetry: Telemetry, trace_id: string ): Promise<void> {
    //console.log( 'starting to process:' + mq_message_data.link );
    // get full link HTML
    try {
      const url_status_span_name: string = 'rss_link_fetch_get_html';

      await analysis_telemetry.add_span( url_status_span_name, { 'feed_url' : mq_message_data.url } );
      let link_data: { status: number, data: string, link_url: string } = await this.get_url_data( mq_message_data.link );

      // add to retry queue if this link's fetch has failed
      if ( link_data.status != 200 ) {
        //console.log( 'non-200 code (' + link_data.status + ') for: ' + mq_message_data.link + ', retrying later' );
        if ( !this.retries[ mq_message_data.link ] || this.retries[ mq_message_data.link ].retries < this.max_retries ) {
          if ( !this.retries[ mq_message_data.link ] ) {
            this.retries[ mq_message_data.link ] = { retries: 1, callback: async () => await this.parse_link_url( mq_message_data, analysis_telemetry, trace_id ) };
          } else {
            this.retries[ mq_message_data.link ].retries++;
          }
        }
      } else if ( link_data.data != '' ) {
        // we've got the HTML, let's try to find the correct part of it
        const final_html = this.detect_article_text( mq_message_data.title, link_data.data );

        // check that this is not a redirect page (such as one from Google News)
        if ( final_html.trim().split(' ').length < 5 && ( final_html.indexOf( 'http://' ) > -1 || final_html.indexOf( 'https://' ) > -1 ) ) {
          // try to find a HTTP or HTTPS redirect address
          const regex = /(https?:\/\/[^ \n\r\t]+)/gm;
          let m;
          while ( ( m = regex.exec( final_html ) ) !== null ) {
            // This is necessary to avoid infinite loops with zero-width matches
            if ( m.index === regex.lastIndex ) {
              regex.lastIndex++;
            }

            // The result can be accessed through the `m`-variable.
            if ( m.length == 2 ) {
              //console.log( 'following redirect of ' + mq_message_data.link + ' to ' + m[ 1 ] );
              // this is very likely a redirect URL, let's follow that redirect
              // ... remove the original cached queue item first, since we're changing the message object and otherwise
              //     we wouldn't be able to find it anymore
              await this.key_store_pub.sdelete( this.key_value_queue_backup_set_name, JSON.stringify( { message: mq_message_data, trace_id: trace_id } ) );
              mq_message_data.original_link = mq_message_data.link;
              mq_message_data.link = m[ 1 ];
              this.parse_link_url( mq_message_data, analysis_telemetry, trace_id );

              return;
            }
          }
        }

        // save the resulting HTML into the database
        Utils.checkAndCacheFeedURL( mq_message_data.feed_url ).then( async ( result: boolean ) => {
          if ( result ) {
            await this.dbconn.update_link_html( Utils.feed_url_to_id[ mq_message_data.feed_url ], ( mq_message_data.original_link ? mq_message_data.original_link : mq_message_data.link ), final_html );
            await this.key_store_pub.sdelete( this.key_value_queue_backup_set_name, JSON.stringify( { message: mq_message_data, trace_id: trace_id } ) );
            //console.log( 'finished processing of ' + mq_message_data.link );
          } else {
            console.log( this.logger.format( 'could not retrieve feed ID for ' + mq_message_data.feed_url ) );
          }
        });
      }

      analysis_telemetry.close_active_span( url_status_span_name );
    } catch ( err ) {
      const telemetry_name: string = 'rss_links_fetch';
      await this.logger.log_msg( 'Error processing link data for ' + mq_message_data.link + ' with error: ' + JSON.stringify( err ), 'ERR_RSS_LINK_FETCH_PROCESSING', LOG_SEVERITIES.LOG_SEVERITY_ERROR, { feed_url: mq_message_data.url } );
      await analysis_telemetry.add_span( telemetry_name, {}, 'Error processing link data for ' + mq_message_data.link + ' with error: ' + JSON.stringify( err ), parseInt( await this.key_store_pub.get( 'ERR_RSS_LINK_FETCH_PROCESSING' ) ) );
      analysis_telemetry.close_active_span( telemetry_name );
    }

    // remove this job from the backup queue
    this.key_store_pub.sdelete( this.key_value_queue_backup_set_name, JSON.stringify( { message: mq_message_data, trace_id: trace_id } ) );

    // publish to key store that we're done with tracing
    await this.key_store_pub.publish( env.TELEMETRY_CHANNEL_NAME, JSON.stringify( { service: this.service_name, trace_id: trace_id } ) );
  }

  /**
   * Performs detection of the container in which our link title resides.
   * If that container is found, its inner HTML is returned.
   * If that container is not found, HTML of the full page if returned.
   *
   * @param { string } link_title Title of the article.
   * @param { string } html       The HTML of full article page.
   * @private
   */
  private detect_article_text( link_title: string, html: string ): string {
    let
      blog_article_text = '',
      query = $( html );

    // try searching for the most obvious H1 tag and its container
    query.find( 'h1' ).each(( index, element ) => {
      blog_article_text = this.find_article_text( $( element ), link_title );
    });

    // H1 tag search not fruitful, try H2
    if ( !blog_article_text ) {
      query.find( 'h2' ).each(( index, element ) => {
        blog_article_text = this.find_article_text( $( element ), link_title );
      });
    }

    // H2 tag search not fruitful, try H3
    if ( !blog_article_text ) {
      query.find( 'h3' ).each(( index, element ) => {
        blog_article_text = this.find_article_text( $( element ), link_title );
      });
    }

    // H3 tag search not fruitful, try H4
    if ( !blog_article_text ) {
      query.find( 'h4' ).each(( index, element ) => {
        blog_article_text = this.find_article_text( $( element ), link_title );
      });
    }

    // try to find the title text on the page inside of any element,
    // since bad and old pages wouldn't adhere to any SEO standards
    // and will put title inside <font> tags
    if ( !blog_article_text ) {
      let node = query.find( "body *:contains('" + Utils.untagize( link_title, false ).replace( '"', '' ) + "'):last" );
      if ( node.length ) {
        while ( Utils.untagize( node.html(), false ).length < ( link_title.length + 500 ) ) {
          node = node.parent();
        }

        blog_article_text = Utils.untagize( node.html(), false );
      }
    }

    // the article title was not found in the page - use whole page HTML
    if ( !blog_article_text ) {
      blog_article_text = Utils.untagize( html.substring( html.indexOf( '<body' ) ), false );
    }

    return blog_article_text;
  }

  /**
   * Tries to find the relevant HTML container element
   * for the link title and returns the HTML of that
   * container element, or empty string if the container element
   * cannot be found.
   *
   * @param { any }      html_element The HTML element selected by jQuery.
   * @param { string } link_title   Title of the link from which the HTML originates.
   * @private
   */
  private find_article_text( html_element: any, link_title: string ): string {
    // if we found our link title inside of this element, let's try to find the article container
    const cleared_up_text = Utils.untagize( html_element.html(), false );

    if ( cleared_up_text == link_title ) {
      // go up until we have at least the title + 500 other characters
      // which would signify some sort of an article element
      // ... this does not need to be precise - even if we select words
      //     from ads and other links on page, the content will remain relevant
      //     to this source's theme
      while ( Utils.untagize( html_element.html(), false ).length < ( link_title.length + 500 ) ) {
        html_element = html_element.parent();
        if ( !html_element.length ) {
          break;
        }
      }

      return Utils.untagize( html_element.html(), false );
    }

    // title not found inside the given HTML element
    return '';
  }

  /**
   * Retrieves URL data including its status code
   * and returns this for further processing.
   *
   * @param {string } url URL to get status code and data for.
   * @private
   * @return { Object } Returns an object with "status" and "data" keys.
   */
  private async get_url_data( url: string ): Promise<{ status: number, data: string, link_url: string }> {
    try {
      let
        self = this,
        res  = await fetch( url, {
          agent:   function ( _parsedURL ) {
            if ( _parsedURL.protocol == 'http:' ) {
              return self.http_agent;
            } else {
              return self.https_agent;
            }
          },
          headers: {
            // spoof desktop browser, otherwise some services would return an error status code
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/116.0',
          },
          follow: 10,
        } );

      // check that we don't have a messed-up encoding after using UTF-8
      const buff = await res.arrayBuffer();
      let txt = ( new TextDecoder('utf-8') ).decode( buff );

      // UTF-8 didn't work for this link, let's try to guess one
      if ( txt.indexOf('��') > -1 ) {
        try {
          // @ts-ignore
          const guessed_encoding = await languageEncoding( Buffer.from( new Uint8Array( buff ) ) );
          if ( guessed_encoding && guessed_encoding.encoding ) {
            txt = ( new TextDecoder( guessed_encoding.encoding ) ).decode( buff );

            // we still have the encoding wrong - nothing to do here now
            if ( txt.indexOf('��') > -1 ) {
              self.logger.log_msg( 'Error while trying to fix encoding for link ' + url + ': encoding guess incorrect, data unreadable', 'ERR_RSS_LINK_FETCH_ENCODING_ERROR' );
              txt = '';
            }
          }
        } catch ( err ) {
          // if we couldn't guess an encoding of the link, just return an empty string
          self.logger.log_msg( 'Error while trying to fix encoding for link ' + url + ': ' + JSON.stringify( err ), 'ERR_RSS_LINK_FETCH_ENCODING_ERROR' );
          txt = '';
        }
      }

      return { status: res.status, data: txt, link_url: url };
    } catch ( err ) {
      return { status: -1, data: JSON.stringify( err ), link_url: '' };
    }
  }

}