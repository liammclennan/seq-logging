"use strict";

let assert = require('assert');
let simple = require('simple-mock');
const http = require("http");
let SeqLogger = require('../seq_logger');

describe('SeqLogger', () => {
    
   describe('constructor()', () => {
      it('defaults missing configuration arguments', () => {
         let logger = new SeqLogger();
         assert.strictEqual(logger._endpoint.hostname, 'localhost'); 
         assert.strictEqual(logger._endpoint.port, '5341'); 
         assert.strictEqual(logger._endpoint.protocol, 'http:');
         assert.strictEqual(logger._endpoint.path, '/api/events/raw');         
         assert.strictEqual(logger._apiKey, null);
         assert.strictEqual(logger._maxRetries, 5);
         assert.strictEqual(logger._retryDelay, 5000);
      });
      
      it('uses configuration arguments that are provided', () => {
         let logger = new SeqLogger({ serverUrl: 'https://my-seq/prd', apiKey: '12345', maxRetries: 10, retryDelay: 10000 });
         assert.strictEqual(logger._endpoint.hostname, 'my-seq'); 
         assert.strictEqual(logger._endpoint.port, null); 
         assert.strictEqual(logger._endpoint.protocol, 'https:');
         assert.strictEqual(logger._endpoint.path, '/prd/api/events/raw');         
         assert.strictEqual(logger._apiKey, '12345');
         assert.strictEqual(logger._maxRetries, 10);
         assert.strictEqual(logger._retryDelay, 10000);
      });
      
      it('correctly formats slashed paths', () => {
         let logger = new SeqLogger({serverUrl: 'https://my-seq/prd/'});
         assert.strictEqual(logger._endpoint.path, '/prd/api/events/raw');         
      });
   });

   describe('emit()', () => {
      it('detects missing event', () => {
          let logger = new SeqLogger();
          try {
              logger.emit();
          } catch (e) {
              return;
          }
          assert.fail(null, null, 'Expected an error');
      });
      
      it('enqueues events', () => {
          let logger = new SeqLogger();
          logger.emit(makeTestEvent());
          logger._clearTimer();
          assert.strictEqual(1, logger._queue.length);
      });
      
      it('ignores calls afer the logger is closed', () => {
          let logger = new SeqLogger();
          return logger.close().then(() => {
             logger.emit(makeTestEvent());
             assert.strictEqual(0, logger._queue.length); 
          });
      });
      
      it('converts events to the wire format', () => {
          let logger = new SeqLogger();
          let event = makeTestEvent();
          logger.emit(event);
          logger._clearTimer();
          let wire = logger._queue[0];
          assert.strictEqual(event.messageTemplate, wire.MessageTemplate);
          assert.strictEqual(event.timestamp, wire.Timestamp);
          assert.strictEqual(event.level, wire.Level);
          assert.strictEqual(event.exception, wire.Exception);
          assert.strictEqual(event.properties.a, wire.Properties.a);
      });

      it('handles missing data in wire format', () => {
        let logger = new SeqLogger();
        let event = {}
        logger.emit(event);
        logger._clearTimer();
        let wire = logger._queue[0];
        assert(wire.Timestamp instanceof Date);
        assert.strictEqual("(No message provided)", wire.MessageTemplate);
        assert.strictEqual("undefined", typeof wire.Exception);
        assert.strictEqual("undefined", typeof wire.Level);
        assert.strictEqual("undefined", typeof wire.Properties);
      });

      it('handles invalid data in wire format', () => {
        let logger = new SeqLogger();
        let event = {
            timestamp: 'helo',
            level: 3,
            messageTemplate: {},
            exception: new Error('broken'),
            properties: 5
        }
        logger.emit(event);
        logger._clearTimer();
        let wire = logger._queue[0];
        assert(wire.Timestamp instanceof Date);
        assert.strictEqual("[object Object]", wire.MessageTemplate);
        assert.strictEqual("Error: broken", wire.Exception);
        assert.strictEqual("undefined", typeof wire.Level);
        assert.strictEqual("undefined", typeof wire.Properties);
      });
   });

   describe('flushToBeacon()', function() {
       const sendBeacon = simple.stub().returnWith(true);
       const MockBlob = function MockBlob(blobParts, options) {
           this.size = blobParts.join('').length;
           this.type = (options && options.type) || ''
       }

       beforeEach(function() {
           simple.mock(global, 'navigator', {sendBeacon});
           simple.mock(global, 'Blob', MockBlob);
       });

       it('return false with no events', function() {
           let logger = new SeqLogger();
           const result = logger.flushToBeacon();
           assert.strictEqual(result, false);
       });

       it('formats url to include api key', function() {
           let logger = new SeqLogger({serverUrl: 'https://my-seq/prd', apiKey: '12345'});
           let event = makeTestEvent();
           logger.emit(event);
           logger._clearTimer();
           const {dataParts, options, beaconUrl, size} = logger._prepForBeacon({batch: [], bytes: 11});
           assert.strictEqual(beaconUrl, 'https://my-seq/prd/api/events/raw?apiKey=12345');
       });

       it('queues beacon', function() {
           let logger = new SeqLogger({serverUrl: 'https://my-seq/prd', apiKey: '12345'});
           let event = makeTestEvent();
           logger.emit(event);
           logger._clearTimer();
           const result = logger.flushToBeacon();
           assert(result);
           assert.strictEqual(sendBeacon.callCount, 1);
           assert.strictEqual(sendBeacon.lastCall.args[0], 'https://my-seq/prd/api/events/raw?apiKey=12345');
           assert.strictEqual(sendBeacon.lastCall.args[1].type, 'text/plain');
           assert.strictEqual(sendBeacon.lastCall.args[1].size, 166);
       });

       it('does handle event properties with circular structures', () => {
        let logger = new SeqLogger({serverUrl: 'https://my-seq/prd', apiKey: '12345'});
        const event = makeCircularTestEvent();
        logger.emit(event);
        logger.flushToBeacon();
      });

       afterEach(function() {
            sendBeacon.reset();
            simple.restore();
       });
   });
    describe("_post()", function () {
        it("retries 5 times after 5xx response from seq server", async () => {
            const mockSeq = new MockSeq();
            try {
                const logger = new SeqLogger({ serverUrl: 'http://localhost:3000', maxBatchingTime: 1, retryDelay: 100 });
                const event = makeTestEvent();

                mockSeq.status = 500;
                logger.emit(event);
                await logger.flush();
                assert.strictEqual(mockSeq.requestCount, 5);
                await logger.close();
            } finally {
                mockSeq.close();
            }
        });

        it("does not retry on 4xx responses", async () => {
            const mockSeq = new MockSeq();
            try {
                const logger = new SeqLogger({ serverUrl: 'http://localhost:3000', maxBatchingTime: 1, retryDelay: 100 });
                const event = makeTestEvent();

                mockSeq.status = 400;
                logger.emit(event);
                await logger.flush();
                assert.strictEqual(mockSeq.requestCount, 1);
                await logger.close();
            } finally {
                mockSeq.close();
            }
        });

        it("retries the amount of times set in configuration", async () => {
            const mockSeq = new MockSeq();
            try {
                const logger = new SeqLogger({ serverUrl: 'http://localhost:3000', maxBatchingTime: 1, retryDelay: 100, maxRetries: 7 });
                const event = makeTestEvent();
    
                mockSeq.status = 503;
                logger.emit(event);
                await logger.flush();
                assert.strictEqual(mockSeq.requestCount, 7);
                await logger.close()
            } finally {
                mockSeq.close();
            }
        });


    });
});

class MockSeq extends http.Server {
    constructor() {
        super((_, res) => {
            res.statusCode = this.status;
            this.requestCount++;
            res.end()
        });
        this.status = 200;
        this.requestCount = 0;
        this.listen(3000, "localhost");
    }
}

function makeTestEvent() {
    return {
        level: "Error",
        timestamp: new Date(),
        messageTemplate: 'Hello!',
        exception: "Some error at some file on some line",
        properties: { "a": 1 }
    };
}

function makeCircularTestEvent() {
    const a = {};
    a.a = a;

    return {
        level: "Error",
        timestamp: new Date(),
        messageTemplate: 'Circular structure issue!',
        exception: "Some error at some file on some line",
        properties: { a }
    };
}
