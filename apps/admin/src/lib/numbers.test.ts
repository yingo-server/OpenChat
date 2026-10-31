import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatThousands, formatRate, trendOf, TREND_ARROW } from './numbers';

test('formatThousands 千分位', () => {
  assert.equal(formatThousands(0), '0');
  assert.equal(formatThousands(999), '999');
  assert.equal(formatThousands(1234567), '1,234,567');
  assert.equal(formatThousands(-98765), '-98,765');
  assert.equal(formatThousands(1234.6), '1,235');
  assert.equal(formatThousands(null), '—');
  assert.equal(formatThousands(undefined), '—');
  assert.equal(formatThousands(Number.NaN), '—');
});

test('formatRate 速率格式化', () => {
  assert.equal(formatRate(0), '0/s');
  assert.equal(formatRate(0.04), '0/s');
  assert.equal(formatRate(1.25), '1.3/s');
  assert.equal(formatRate(1234.5), '1,235/s');
  assert.equal(formatRate(null), '—');
});

test('trendOf 趋势判断与箭头', () => {
  assert.equal(trendOf(10, 5), 'up');
  assert.equal(trendOf(5, 10), 'down');
  assert.equal(trendOf(10, 10), 'flat');
  assert.equal(trendOf(10, 10.4), 'flat'); // 死区内
  assert.equal(trendOf(null, 5), 'flat');
  assert.equal(TREND_ARROW.up, '↑');
  assert.equal(TREND_ARROW.flat, '→');
});
