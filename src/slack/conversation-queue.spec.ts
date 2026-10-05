import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationQueue } from './conversation-queue';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

void test('a burst of messages becomes one batch', async () => {
  const batches: string[][] = [];
  const queue = new ConversationQueue<string>(30, 1000, async (_key, batch) => {
    batches.push(batch);
  });
  queue.push('dm', 'Any emails from Analia?');
  await sleep(10);
  queue.push('dm', 'Or Wozniak?');
  await sleep(10);
  queue.push('dm', 'Chris Wozniak business');
  await sleep(80);
  assert.deepEqual(batches, [['Any emails from Analia?', 'Or Wozniak?', 'Chris Wozniak business']]);
});

void test('a message sent mid-answer waits for that answer, then runs on its own', async () => {
  const batches: string[][] = [];
  let finishFirst!: () => void;
  const queue = new ConversationQueue<string>(10, 1000, async (_key, batch) => {
    batches.push(batch);
    if (batches.length === 1) await new Promise<void>((resolve) => (finishFirst = resolve));
  });
  queue.push('dm', 'draft a reply to Analia');
  await sleep(30);
  queue.push('dm', 'make Susan the one in charge');
  queue.push('dm', 'and bold the call line');
  await sleep(30);
  // Still answering the first: nothing else may start.
  assert.equal(batches.length, 1);
  finishFirst();
  await sleep(40);
  assert.deepEqual(batches, [
    ['draft a reply to Analia'],
    ['make Susan the one in charge', 'and bold the call line'],
  ]);
});

void test('separate conversations do not wait for each other', async () => {
  const seen: string[] = [];
  const queue = new ConversationQueue<string>(10, 1000, async (key) => {
    seen.push(key);
    await sleep(50);
  });
  queue.push('matthew-dm', 'a');
  queue.push('dreka-dm', 'b');
  await sleep(30);
  assert.deepEqual(seen.sort(), ['dreka-dm', 'matthew-dm']);
});

void test('a steady stream still runs once the maximum wait is reached', async () => {
  const batches: number[][] = [];
  const queue = new ConversationQueue<number>(40, 60, async (_key, batch) => {
    batches.push(batch);
  });
  for (let i = 0; i < 5; i += 1) {
    queue.push('dm', i);
    await sleep(20);
  }
  await sleep(80);
  assert.ok(batches.length >= 2, `expected the stream split, got ${JSON.stringify(batches)}`);
  assert.deepEqual(batches.flat(), [0, 1, 2, 3, 4]);
});

void test('a failing batch does not stop the next one', async () => {
  const batches: string[][] = [];
  const queue = new ConversationQueue<string>(10, 1000, async (_key, batch) => {
    batches.push(batch);
    if (batches.length === 1) throw new Error('model unavailable');
  });
  queue.push('dm', 'first');
  await sleep(30);
  queue.push('dm', 'second');
  await sleep(30);
  assert.deepEqual(batches, [['first'], ['second']]);
});
