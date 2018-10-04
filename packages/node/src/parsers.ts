import { SentryEvent, SentryException, StackFrame } from '@sentry/types';
import { readFileAsync } from '@sentry/utils/fs';
import { snipLine } from '@sentry/utils/string';
import * as path from 'path';
import * as stacktrace from 'stack-trace';

const LINES_OF_CONTEXT: number = 7;

/**
 * Just an Error object with arbitrary attributes attached to it.
 */
interface ExtendedError extends Error {
  [key: string]: any;
}

/** JSDoc */
function getFunction(frame: stacktrace.StackFrame): string {
  try {
    return frame.getFunctionName() || `${frame.getTypeName()}.${frame.getMethodName() || '<anonymous>'}`;
  } catch (e) {
    // This seems to happen sometimes when using 'use strict',
    // stemming from `getTypeName`.
    // [TypeError: Cannot read property 'constructor' of undefined]
    return '<anonymous>';
  }
}

const mainModule: string = `${(require.main && require.main.filename && path.dirname(require.main.filename)) ||
  global.process.cwd()}/`;

/** JSDoc */
function getModule(filename: string, base?: string): string {
  if (!base) {
    base = mainModule; // tslint:disable-line:no-parameter-reassignment
  }

  // It's specifically a module
  const file = path.basename(filename, '.js');
  filename = path.dirname(filename); // tslint:disable-line:no-parameter-reassignment
  let n = filename.lastIndexOf('/node_modules/');
  if (n > -1) {
    // /node_modules/ is 14 chars
    return `${filename.substr(n + 14).replace(/\//g, '.')}:${file}`;
  }
  // Let's see if it's a part of the main module
  // To be a part of main module, it has to share the same base
  n = `${filename}/`.lastIndexOf(base, 0);
  if (n === 0) {
    let moduleName = filename.substr(base.length).replace(/\//g, '.');
    if (moduleName) {
      moduleName += ':';
    }
    moduleName += file;
    return moduleName;
  }
  return file;
}

/** JSDoc */
async function readSourceFiles(
  filenames: string[],
): Promise<{
  [key: string]: string;
}> {
  // we're relying on filenames being de-duped already
  if (filenames.length === 0) {
    return {};
  }

  const sourceFiles: {
    [key: string]: string;
  } = {};

  await Promise.all(
    filenames.map(async filename => {
      let content;
      try {
        content = await readFileAsync(filename);
      } catch (_) {
        // unsure what to add here as the file is unreadable
        content = null;
      }
      if (typeof content === 'string') {
        sourceFiles[filename] = content;
      }
    }),
  );

  return sourceFiles;
}

/** JSDoc */
export async function extractStackFromError(error: Error): Promise<stacktrace.StackFrame[]> {
  const stack = stacktrace.parse(error);
  if (!stack) {
    return [];
  }
  return stack;
}

/** JSDoc */
export async function parseStack(stack: stacktrace.StackFrame[]): Promise<StackFrame[]> {
  const filesToRead: string[] = [];
  const frames: StackFrame[] = stack.map(frame => {
    const parsedFrame: StackFrame = {
      colno: frame.getColumnNumber(),
      filename: frame.getFileName() || '',
      function: getFunction(frame),
      lineno: frame.getLineNumber(),
    };

    const isInternal =
      frame.isNative() ||
      (parsedFrame.filename &&
        !parsedFrame.filename.startsWith('/') &&
        !parsedFrame.filename.startsWith('.') &&
        parsedFrame.filename.indexOf(':\\') !== 1);

    // in_app is all that's not an internal Node function or a module within node_modules
    // note that isNative appears to return true even for node core libraries
    // see https://github.com/getsentry/raven-node/issues/176
    parsedFrame.in_app =
      !isInternal && parsedFrame.filename !== undefined && !parsedFrame.filename.includes('node_modules/');

    // Extract a module name based on the filename
    if (parsedFrame.filename) {
      parsedFrame.module = getModule(parsedFrame.filename);

      if (!isInternal) {
        filesToRead.push(parsedFrame.filename);
      }
    }

    return parsedFrame;
  });

  try {
    return await addPrePostContext(filesToRead, frames);
  } catch (_) {
    // This happens in electron for example where we are not able to read files from asar.
    // So it's fine, we recover be just returning all frames without pre/post context.
    return frames;
  }
}

/**
 * This function tries to read the source files + adding pre and post context (source code)
 * to a frame.
 * @param filesToRead string[] of filepaths
 * @param frames StackFrame[] containg all frames
 */
async function addPrePostContext(filesToRead: string[], frames: StackFrame[]): Promise<StackFrame[]> {
  const sourceFiles = await readSourceFiles(filesToRead);
  return frames.map(frame => {
    if (frame.filename && sourceFiles[frame.filename]) {
      try {
        const lines = sourceFiles[frame.filename].split('\n');

        frame.pre_context = lines
          .slice(Math.max(0, (frame.lineno || 0) - (LINES_OF_CONTEXT + 1)), (frame.lineno || 0) - 1)
          .map((line: string) => snipLine(line, 0));

        frame.context_line = snipLine(lines[(frame.lineno || 0) - 1], frame.colno || 0);

        frame.post_context = lines
          .slice(frame.lineno || 0, (frame.lineno || 0) + LINES_OF_CONTEXT)
          .map((line: string) => snipLine(line, 0));
      } catch (e) {
        // anomaly, being defensive in case
        // unlikely to ever happen in practice but can definitely happen in theory
      }
    }
    return frame;
  });
}

/** JSDoc */
export async function getExceptionFromError(error: Error): Promise<SentryException> {
  const name = error.name || error.constructor.name;
  const stack = await extractStackFromError(error);
  const frames = await parseStack(stack);

  return {
    stacktrace: {
      frames: prepareFramesForEvent(frames),
    },
    type: name,
    value: error.message,
  };
}

/** JSDoc */
export async function parseError(error: ExtendedError): Promise<SentryEvent> {
  const name = error.name || error.constructor.name;
  const exception = await getExceptionFromError(error);
  const event: SentryEvent = {
    exception: {
      values: [exception],
    },
    message: `${name}: ${error.message || '<no message>'}`,
  };
  const errorKeys = Object.keys(error).filter(key => !(key in ['name', 'message', 'stack', 'domain']));

  if (errorKeys.length) {
    const extraErrorInfo: { [key: string]: any } = {};
    for (const key of errorKeys) {
      extraErrorInfo[key] = error[key];
    }
    event.extra = {
      [name]: extraErrorInfo,
    };
  }

  return event;
}

/** JSDoc */
export function prepareFramesForEvent(stack: StackFrame[]): StackFrame[] {
  if (!stack || !stack.length) {
    return [];
  }

  let localStack = stack;
  const firstFrameFunction = localStack[0].function || '';

  if (firstFrameFunction.includes('captureMessage') || firstFrameFunction.includes('captureException')) {
    localStack = localStack.slice(1);
  }

  // The frame where the crash happened, should be the last entry in the array
  return localStack.reverse();
}
