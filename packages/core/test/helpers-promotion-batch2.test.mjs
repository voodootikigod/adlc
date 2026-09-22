import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeCommand } from '../index.mjs';

describe('tokenizeCommand', () => {
  test('returns empty array for empty string', () => {
    assert.deepEqual(tokenizeCommand(''), []);
  });

  test('splits command on unquoted spaces with no quotes', () => {
    assert.deepEqual(tokenizeCommand('git status --short'), ['git', 'status', '--short']);
  });

  test('splits command on unquoted tabs and newlines', () => {
    assert.deepEqual(tokenizeCommand("cmd\targ1\narg2\t\narg3"), ['cmd', 'arg1', 'arg2', 'arg3']);
  });

  test('ignores leading, trailing, and consecutive whitespace', () => {
    assert.deepEqual(tokenizeCommand('   node   script.mjs   --flag   '), ['node', 'script.mjs', '--flag']);
  });

  test('strips double quotes and preserves whitespace enclosed in double quotes', () => {
    assert.deepEqual(tokenizeCommand('git commit --msg "hello world"'), ['git', 'commit', '--msg', 'hello world']);
  });

  test('strips single quotes and preserves whitespace enclosed in single quotes', () => {
    assert.deepEqual(tokenizeCommand("git commit --msg 'hello world'"), ['git', 'commit', '--msg', 'hello world']);
  });

  test('handles mixed single and double quotes in different arguments', () => {
    assert.deepEqual(
      tokenizeCommand("runner --title 'My Title' --desc \"Some Description\""),
      ['runner', '--title', 'My Title', '--desc', 'Some Description']
    );
  });

  test('handles quotes adjacent to characters or adjoining quotes', () => {
    assert.deepEqual(tokenizeCommand('--opt="value with spaces"'), ['--opt=value with spaces']);
    assert.deepEqual(tokenizeCommand("foo'bar'baz"), ['foobarbaz']);
    assert.deepEqual(tokenizeCommand("''"), ['']);
    assert.deepEqual(tokenizeCommand('""'), ['']);
    assert.deepEqual(tokenizeCommand('cmd ""'), ['cmd', '']);
  });

  test('preserves tabs and newlines inside quotes', () => {
    assert.deepEqual(tokenizeCommand('echo "line1\nline2\tindented"'), ['echo', 'line1\nline2\tindented']);
  });

  test('throws on unterminated double quote', () => {
    assert.throws(
      () => tokenizeCommand('node -e "oops'),
      /Unterminated quote in command template: node -e "oops/
    );
  });

  test('throws on unterminated single quote', () => {
    assert.throws(
      () => tokenizeCommand("node -e 'oops"),
      /Unterminated quote in command template: node -e 'oops/
    );
  });
});
