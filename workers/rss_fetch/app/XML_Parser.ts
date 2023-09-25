import { DateTime } from "luxon";
import Parser from "rss-parser";
import { Utils } from './Utils/Utils.js';
import { env } from 'node:process';

export class XML_Parser {

  /**
   * RSS Parser class instance.
   * @type { Parser }
   * @private
   */
  private readonly rss_parser: Parser;

  /**
   * Creates instance of the RSS XML Parser class to be used
   * thorough for all of the XML parsing.
   */
  constructor() {
    this.rss_parser = new Parser({
      customFields: {
        item: [ 'media:group', 'links', 'editor', 'AuthorName' ],
      },
      requestOptions: {
        rejectUnauthorized: false // ignore invalid SSL certificates
      }
    });
  }

  /**
   * Processes XML feed data and publishes each item
   * as a individual Kafka message for further processing.
   *
   * @param { string } xml_data  The raw XML markup data from an RSS feed.
   * @param { string } feed_url  URL of the feed from which the XML data originates.
   * @param { string } kafka_key Key for this link message received from Kafka.
   *                             This is actually a trace ID that needs to be passed on.
   * @private
   */
  public async process_xml_feed( xml_data: string, feed_url: string, kafka_key: string ): Promise<void> {
    try {
      let
        feed: { [p: string]: any } & Parser.Output<{ [p: string]: any }> = await this.rss_parser.parseString( xml_data ),
        // we will sort final Kafka item messages by date, so they are ordered from oldest to newest
        items_to_sort: Array<Object> = [],
        url_counter = 1;

      if ( !feed.items.length ) {
        throw 'invalid XML feed data, no items found';
      }

      for ( let item of feed.items ) {
        let
          url: string = item.link,
          summary: string = item.summary,
          link_img: string = '',
          categories: Array<string> = [],
          authors: Array<string> = [],
          date_published: number = Math.round( Date.now() / 1000 );

        // if summary is empty, try to look for it in other known fields
        if ( !summary ) {
          if ( item.description ) {
            summary = item.description;
          } else if ( item.contentSnippet ) {
            summary = item.contentSnippet;
          }
        }

        // try looking inside of links array, if it exists
        if ( ( !url || typeof( url ) == 'undefined' ) && item.links && item.links instanceof Array && item.links.length ) {
          if ( typeof( item.links[0] ) === 'string' ) {
            url = item.links[0].toString();
          } else {
            url = item.links[0]['$'].href;
          }
        }

        // try to extract link image
        link_img = this.xml_item_get_main_image( item );

        // check for categories
        if ( item.categories && item.categories instanceof Array && item.categories.length ) {
          categories = item.categories;
        }

        // try to get the author
        if ( item.creator || item.editor || item.AuthorName ) {
          if ( item.creator ) {
            authors.push( item.creator );
          } else if ( item.editor ) {
            authors.push( item.editor );
          } else if ( item.AuthorName ) {
            authors.push( item.AuthorName );
          }
        }

        // update the published date, if one is found
        if ( item.isoDate ) {
          date_published = DateTime.fromISO( item.isoDate ).toUnixInteger();
        }

        // still no url, make it a hash with published date
        if ( !url || typeof( url ) == 'undefined' ) {
          url = '#' + feed_url.replace( 'http://', '' ).replace( 'https://', '' ) + date_published + url_counter++;
        }

        if ( !summary && item.contentSnippet ) {
          summary = item.contentSnippet;
        }

        let feed_item_info: Object = {
          'title':     Utils.untagize( item.title ),
          'summary':   Utils.untagize( summary ),
          'link':      url,
          'img':       link_img,
          'published': date_published,
          'feed_url':  feed_url,
        };

        if ( categories.length ) {
          feed_item_info[ 'categories' ] = categories;
        }

        if ( authors.length ) {
          feed_item_info[ 'authors' ] = authors;
        }

        items_to_sort.push( feed_item_info );
      }

      // sort items by date, ascending (oldest to newest)
      items_to_sort.sort( (a: Object, b: Object): number => {
        return a[ 'published' ] - b[ 'published' ];
      });

      // fire up links data
      for ( let link_data of items_to_sort ) {
        await Utils.publish_new_link_data( link_data, kafka_key );
      }

      // because we're sending in batches, let's send what's left of this feed's links
      Utils.mq_producer.drain_batch();
    } catch ( err ) {
      // invalid XML feed data
      throw 'invalid XML feed data, error returned: ' + JSON.stringify( err );
    }
  }

  /**
   * Determines main image URL from an XML feed item.
   *
   * @param { Object } item XML feed item to get main image URL from.
   * @private
   * @return { string } Returns URL for the main image of the given item or empty string if no image was found.
   */
  public xml_item_get_main_image( item: {[p: string]: any} & Parser.Item ): string {
    let
      img: string = '',
      image_extensions: Array<string> = [ 'jpg', 'jpeg', 'gif', 'png', 'bmp', 'tif', 'tiff' ];

    // feeds usually provide thumbnails in the link enclosure
    // let's do a super-simple educated guess here
    if ( item.enclosure && item.enclosure.url && image_extensions.indexOf( Utils.get_file_extension( item.enclosure.url ).toLowerCase() ) > -1 ) {
      img = item.enclosure.url;
    } else if ( item[ 'media:group' ] && item[ 'media:group' ][ 'media:thumbnail' ] && item[ 'media:group' ][ 'media:thumbnail' ][ 0 ] && item[ 'media:group' ][ 'media:thumbnail' ][ 0 ][ '$' ] && item[ 'media:group' ][ 'media:thumbnail' ][ 0 ] && item[ 'media:group' ][ 'media:thumbnail' ][ 0 ][ '$' ][ 'url' ] ) {
      img = item[ 'media:group' ][ 'media:thumbnail' ][ 0 ][ '$' ][ 'url' ]; // YouTube thumbnail
    } else if ( item.image && ( ( item.image instanceof Array && item.image[0].url && typeof( item.image[0].url ) != 'undefined' ) || typeof( item.image ) === 'string' ) ) {
      if ( item.image instanceof Array ) {
        img = item.image[0].url;
      } else {
        img = item.image;
      }
    } else if ( item.content ) {
      // check if we can find image in the description
      img = Utils.get_first_img_from_html( item.content );
    } else if ( item.summary ) {
      // check if we can find image in the summary
      img = Utils.get_first_img_from_html( item.summary );
    }

    return img;
  }

}