import sdk_trace_base_pkg from "@opentelemetry/sdk-trace-base";
import resources_pkg from "@opentelemetry/resources";
import semantic_conventions_pkg from "@opentelemetry/semantic-conventions";
import sdk_trace_node_pkg from "@opentelemetry/sdk-trace-node";
import opentelemetry, { Context, Span, SpanStatusCode } from '@opentelemetry/api';
import exporter_otlp_pkg from '@opentelemetry/exporter-trace-otlp-http';
import exporter_jaeger_pkg from '@opentelemetry/exporter-jaeger';

const { BatchSpanProcessor, SimpleSpanProcessor, ConsoleSpanExporter } = sdk_trace_base_pkg;
const { NodeTracerProvider } = sdk_trace_node_pkg;
const { Resource } = resources_pkg;
const { SemanticResourceAttributes } = semantic_conventions_pkg;
const { OTLPTraceExporter } = exporter_otlp_pkg;
const { JaegerExporter } = exporter_jaeger_pkg;

/**
 * Telemetry class used to record application flow inside a Jaegr server.
 * @class Telemetry
 */
export class Telemetry {

  /**
   * Main app service ID, so we can use it in Redis logs.
   * @private
   * @type { string }
   */
  private readonly service_id: string;

  /**
   * Service name to use for the tracer.
   * All spans will be stored under this single service name.
   * @private
   * @type { string }
   */
  private readonly tracer_service_name: string = 'rss_fetch_flow';

  /**
   * Tracer used to trace all the actual spans with data.
   * @private
   * @type { opentelemetry.Tracer }
   */
  private readonly tracer: opentelemetry.Tracer;

  /**
   * ID of the tracer - this will be the ID under which new root span
   * or child span will be created.
   * @private
   * @type { string }
   */
  private readonly tracer_id: string;

  /**
   * Object carrying trace data, so more spans can be written to it
   * in other applications.
   * @private
   * @type { Object }
   */
  private carrier: Object = {};

  /**
   * A root span element that is closed at the end when all
   * processing has finished or a timeout has passed.
   * @private
   * @type { opentelemetry.Span }
   */
  private root_span: opentelemetry.Span;

  /**
   * Currently active spans that were not closed yet.
   * Each span must have a unique identifier.
   * @private
   * @type { { [k: string] : opentelemetry.Span } }
   */
  private active_spans: { [k: string] : opentelemetry.Span } = {};

  /**
   * Unix timestamp of the last activity that happened
   * in this telemetry lifecycle. Used to time out an inactive
   * span, so it can be closed and marked as timed out.
   * @private
   * @type { number }
   */
  private last_activity_ts: number = 0;

  /**
   * Creates a Jaeger tracer with root span.
   *
   * @param { string } service_id      Name of the app.
   * @param { string } service_version Version of the app.
   * @param { string } tracer_id       Unique ID for the new tracer.
   * @constructor
   */
  constructor( service_id: string, service_version: string, tracer_id: string ) {
    this.service_id = service_id;
    this.tracer_id = tracer_id;

    const resource: resources_pkg.IResource =
            Resource.default().merge(
              new Resource({
                [SemanticResourceAttributes.SERVICE_NAME]: this.tracer_service_name,
                [SemanticResourceAttributes.SERVICE_VERSION]: service_version,
              })
            );

    const provider: sdk_trace_node_pkg.NodeTracerProvider = new NodeTracerProvider({
      resource: resource,
    });

    //const exporter: exporter_otlp_pkg.OTLPTraceExporter = new OTLPTraceExporter();
    const exporter: exporter_jaeger_pkg.JaegerExporter = new JaegerExporter();

    const processor: sdk_trace_base_pkg.BatchSpanProcessor = new BatchSpanProcessor(exporter);
    //const processor = new SimpleSpanProcessor( exporter );
    provider.addSpanProcessor( processor );
    provider.register();

    this.tracer = opentelemetry.trace.getTracer( tracer_id );
  }

  /**
   * Starts a new trace and returns the Telemetry class instance,
   * so we can work with it further.
   *
   * @param { string } carrier         If this carrier information is present, we're coming from
   *                                   an already existing trace and will continue creating spans
   *                                   inside of it.
   */
  public async start( carrier: Object|null = null ): Promise<Telemetry> {
    return await new Promise((resolve, reject) => {
      try {
        if ( carrier ) {
          this.carrier = carrier;
          const activeContext = opentelemetry.propagation.extract( opentelemetry.context.active(), carrier );
          const currentSpan = opentelemetry.trace.getSpan( activeContext );

          // save the root span
          this.root_span = currentSpan;
          this.bump_last_activity();
          resolve( this );
        } else {
          this.tracer.startActiveSpan( this.tracer_id, {}, ( parentSpan ) => {
            // save the root span
            this.root_span = parentSpan;

            // store context, so we can restore it in other services
            opentelemetry.propagation.inject( opentelemetry.context.active(), this.carrier );

            this.bump_last_activity();
            resolve( this );
          });
        }
      } catch ( err ) {
        this.bump_last_activity();
        reject( err );
      }
    });
  }

  /**
   * Starts a span with all the required data.
   *
   * @param { string } span_id                 Unique ID of the span. If an active span with this ID is found,
   *                                           it is closed and a new one is opened.
   * @param { Object | null | undefined } tags Any tags to add to the span.
   * @param { string }  msg                    A plain log message to include.
   * @param { number }  code                   Return code - 0 if all was OK, otherwise a Redis-backed error code.
   */
  public async add_span( span_id: string, tags: Object|null|undefined = null, msg: string = '', code: number = 0 ): Promise<void> {
    return await new Promise(async (resolve, reject) => {
      try {
        if ( this.active_spans[ span_id ] ) {
          this.active_spans[ span_id ].end();
        }

        // create and store new span in the list of active spans
        const
          activeContext: Context = opentelemetry.propagation.extract( opentelemetry.context.active(), this.carrier ),
          new_span: Span = await this.tracer.startSpan( span_id, {}, activeContext );

        this.active_spans[ span_id ] = new_span;

        // add message
        if ( msg ) {
          new_span.addEvent( msg );
        }

        // set status
        new_span.setStatus( { code: ( code == 0 ? SpanStatusCode.OK : SpanStatusCode.ERROR ) } );

        // add any extra data
        if ( tags ) {
          for ( let key in tags ) {
            new_span.setAttribute( key, tags[ key ] );
          }
        }

        this.bump_last_activity();
        resolve();
      } catch ( err ) {
        this.bump_last_activity();
        reject( err );
      }
    });
  }

  /**
   * Ends an active span element.
   * @param { string } span_id The ID of the span to close.
   */
  public close_active_span( span_id: string ): void {
    if ( this.active_spans[ span_id ] ) {
      this.active_spans[ span_id ].end();
      delete this.active_spans[ span_id ];
      this.bump_last_activity();
    }
  }

  /**
   * Ends the root span element, thus finalizing
   * and closing the whole trace.
   */
  public close_root_span(): void {
    this.root_span.end();
    this.bump_last_activity();
  }

  /**
   * Returns a serialized object with traceId and spanId,
   * so it can be used with other services to continue
   * creating their own runtime log data as the flow progresses.
   */
  public get_telemetry_carrier(): string {
    return JSON.stringify( this.carrier );
  }

  /**
   * Returns a raw telemetry carrier.
   */
  public get_telemetry_carrier_raw(): Object {
    return this.carrier;
  }

  /**
   * Returns the unix timestamp of last activity for this telemetry.
   */
  public get_last_activity(): number {
    return this.last_activity_ts;
  }

  /**
   * Sets last activity for this telemetry instance
   * to current timestamp. Usable from other places,
   * so we can do this even when other services end writing
   * into our root span.
   */
  public bump_last_activity(): void {
    this.last_activity_ts = Math.round( Date.now() / 1000 );
  }

  /**
   * Returns the ID of current tracer which is basically root span identifier.
   */
  public get_tracer_id(): string {
    return this.tracer_id;
  }

}