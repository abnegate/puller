const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

type RelativeUnit = {
  milliseconds: number;
  singular: string;
  plural: string;
};

const units: RelativeUnit[] = [
  { milliseconds: YEAR, plural: 'yrs', singular: 'yr' },
  { milliseconds: MONTH, plural: 'months', singular: 'month' },
  { milliseconds: DAY, plural: 'days', singular: 'day' },
  { milliseconds: HOUR, plural: 'hrs', singular: 'hr' },
  { milliseconds: MINUTE, plural: 'mins', singular: 'min' },
];

const getTimestamp = (value: string | number | Date): number => {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === 'number') {
    return value;
  }

  return Date.parse(value);
};

export const formatRelativeTime = (
  value: string | number | Date,
  now = Date.now(),
): string => {
  const timestamp = getTimestamp(value);

  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) {
    return 'Update time unavailable';
  }

  const difference = now - timestamp;
  const absolute = Math.abs(difference);

  if (absolute < MINUTE) {
    return 'just now';
  }

  const unit = units.find(({ milliseconds }) => absolute >= milliseconds);
  if (!unit) {
    return 'just now';
  }

  const amount = Math.floor(absolute / unit.milliseconds);
  const label = amount === 1 ? unit.singular : unit.plural;

  return difference < 0
    ? `in ${amount} ${label}`
    : `${amount} ${label} ago`;
};
