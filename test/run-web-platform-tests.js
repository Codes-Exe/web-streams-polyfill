// This runs the web platform tests against the reference implementation, in Node.js using jsdom, for easier rapid
// development of the reference implementation and the web platform tests.
/* eslint-disable no-console */

const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const micromatch = require('micromatch');
const wptRunner = require('wpt-runner');
const consoleReporter = require('wpt-runner/lib/console-reporter.js');
const { FilteringReporter } = require('./wpt-util/filtering-reporter.js');
const allSettled = require('@ungap/promise-all-settled');

const readFileAsync = promisify(fs.readFile);
const queueMicrotask = global.queueMicrotask || (fn => Promise.resolve().then(fn));

// wpt-runner does not yet support unhandled rejection tracking a la
// https://github.com/w3c/testharness.js/commit/7716e2581a86dfd9405a9c00547a7504f0c7fe94
// So we emulate it with Node.js events
const rejections = new Map();
process.on('unhandledRejection', (reason, promise) => {
  rejections.set(promise, reason);
});

process.on('rejectionHandled', promise => {
  rejections.delete(promise);
});

main().catch(e => {
  console.error(e.stack);
  process.exitCode = 1;
});

async function main() {
  const supportsES2018 = runtimeSupportsAsyncGenerators();

  const excludedTests = [
    // We cannot detect non-transferability, and Node's WebAssembly.Memory is also not marked as such
    'readable-byte-streams/non-transferable-buffers.any.html',
    // Disable tests for different size functions per realm, since they need a working <iframe>
    'queuing-strategies-size-function-per-global.window.html',
    // We don't implement transferable streams yet
    'transferable/**'
  ];
  const ignoredFailures = {
    // We cannot distinguish between a zero-length ArrayBuffer and a detached ArrayBuffer,
    // so we incorrectly throw a TypeError instead of a RangeError
    'readable-byte-streams/bad-buffers-and-views.any.html': [
      'ReadableStream with byte source: respondWithNewView() throws if the supplied view\'s buffer is zero-length ' +
      '(in the closed state)'
    ],
    // Our async iterator won't extend from the built-in %AsyncIteratorPrototype%
    'readable-streams/async-iterator.any.html': [
      'Async iterator instances should have the correct list of properties'
    ]
  };

  const ignoredFailuresMinified = {
    'idlharness.any.html': [
      // Terser turns `(a = undefined) => {}` into `(a) => {}`, changing the function's length property
      // Therefore we cannot correctly implement methods with optional arguments
      /interface: operation (abort|cancel|enqueue|error|getReader|write)/,
      // Same thing for ReadableStream.values(), which is tested as part of the async iterable declaration
      'ReadableStream interface: async iterable<any>'
    ]
  };

  if (!supportsES2018) {
    excludedTests.push(
      // Skip tests that use async generators or for-await-of
      'readable-streams/async-iterator.any.html',
      'readable-streams/patched-global.any.html'
    );
  }

  const ignoredFailuresES5 = merge(ignoredFailures, {
    'idlharness.any.html': [
      // ES5 build does not set correct length on constructors with optional arguments
      'ReadableStream interface object length',
      'WritableStream interface object length',
      'TransformStream interface object length',
      // ES5 build does not set correct length on methods with optional arguments
      /interface: operation \w+\(.*optional.*\)/,
      'ReadableStream interface: async iterable<any>',
      // ES5 build does not set correct function name on getters and setters
      /interface: attribute/,
      // ES5 build has { writable: true } on prototype objects
      /interface: existence and properties of interface prototype object/
    ],
    'queuing-strategies.any.html': [
      // ES5 build turns arrow functions into regular functions, which cannot be marked as non-constructable
      'ByteLengthQueuingStrategy: size should not have a prototype property',
      'CountQueuingStrategy: size should not have a prototype property',
      'ByteLengthQueuingStrategy: size should not be a constructor',
      'CountQueuingStrategy: size should not be a constructor'
    ]
  });

  const results = [];

  results.push(await runTests('polyfill.js', {
    excludedTests,
    ignoredFailures: merge(ignoredFailures, ignoredFailuresMinified)
  }));
  results.push(await runTests('polyfill.es5.js', {
    excludedTests,
    ignoredFailures: merge(ignoredFailuresES5, ignoredFailuresMinified)
  }));

  const failures = results.reduce((sum, result) => sum + result.failures, 0);
  for (const { entryFile, testResults, rejectionsCount } of results) {
    console.log(`> ${entryFile}`);
    console.log(`  * ${testResults.passed} passed`);
    console.log(`  * ${testResults.failed} failed`);
    console.log(`  * ${testResults.ignored} ignored`);
    if (rejectionsCount > 0) {
      console.log(`  * ${rejectionsCount} unhandled promise rejections`);
    }
  }

  process.exitCode = failures;
}

async function runTests(entryFile, { excludedTests = [], ignoredFailures = {} } = {}) {
  const entryPath = path.resolve(__dirname, `../dist/${entryFile}`);
  const wptPath = path.resolve(__dirname, 'web-platform-tests');
  const testsPath = path.resolve(wptPath, 'streams');

  const includedTests = process.argv.length >= 3 ? process.argv.slice(2) : ['**/*.html'];
  const includeMatcher = micromatch.matcher(includedTests);
  const excludeMatcher = micromatch.matcher(excludedTests);
  const workerTestPattern = /\.(?:dedicated|shared|service)worker(?:\.https)?\.html$/;

  const reporter = new FilteringReporter(consoleReporter, ignoredFailures);

  const bundledJS = await readFileAsync(entryPath, { encoding: 'utf8' });

  console.log(`>>> ${entryFile}`);

  const wptFailures = await wptRunner(testsPath, {
    rootURL: 'streams/',
    reporter,
    setup(window) {
      window.queueMicrotask = queueMicrotask;
      window.Promise.allSettled = allSettled;
      window.fetch = async function (url) {
        const filePath = path.join(wptPath, url);
        if (!filePath.startsWith(wptPath)) {
          throw new TypeError('Invalid URL');
        }
        return {
          ok: true,
          async text() {
            return await readFileAsync(filePath, { encoding: 'utf8' });
          }
        };
      };
      const isFakeDetached = new WeakSet();
      const transferArrayBuffer = buffer => {
        const transferredIshVersion = buffer.slice(0);
        window.Object.defineProperty(buffer, 'byteLength', {
          get: () => 0
        });
        isFakeDetached.add(buffer);
        return transferredIshVersion;
      };
      const structuredClone = (value, { transfer }) => {
        if (value instanceof window.ArrayBuffer && transfer.includes(value) && !isFakeDetached.has(value)) {
          return transferArrayBuffer(value);
        }
        throw new TypeError(`Unexpected call to structuredClone`);
      };
      window.structuredClone = structuredClone;
      const originalPostMessage = window.postMessage;
      window.postMessage = function (message, targetOrigin, transfer) {
        message = structuredClone(message, { transfer });
        return originalPostMessage.call(window, message, targetOrigin, transfer);
      };
      window.eval(bundledJS);
    },
    filter(testPath) {
      // Ignore the worker versions
      if (workerTestPattern.test(testPath)) {
        return false;
      }
      return includeMatcher(testPath) && !excludeMatcher(testPath);
    }
  });

  const testResults = reporter.getResults();
  let failures = Math.max(testResults.failed, wptFailures - testResults.ignored);

  if (rejections.size > 0) {
    if (failures === 0) {
      failures = 1;
    }

    console.log();
    for (const reason of rejections.values()) {
      console.error('Unhandled promise rejection: ', reason.stack);
    }
    rejections.clear();
  }

  console.log();

  return { entryFile, failures, testResults, rejectionsCount: rejections.size };
}

function runtimeSupportsAsyncGenerators() {
  try {
    // eslint-disable-next-line no-new-func
    Function('(async function* f() {})')();
    return true;
  } catch (e) {
    return false;
  }
}

function merge(left, right) {
  const result = { ...left };
  for (const key of Object.keys(right)) {
    result[key] = [...(result[key] || []), ...right[key]];
  }
  return result;
}
