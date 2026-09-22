import type { JSX } from 'preact';

type DataAttributes = Record<`data-${string}`, string | number | boolean | undefined>;

export function Switch(
  props: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label?: string;
  } & DataAttributes,
) {
  const { checked, onChange, label, ...rest } = props;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked ? 'true' : 'false'}
      aria-label={label}
      class="switch"
      onClick={() => onChange(!checked)}
      {...rest}
    />
  );
}

export type Option<V extends string> = { value: V; label: string } & DataAttributes;

export function Segmented<V extends string>(props: {
  options: Option<V>[];
  value: V;
  onChange: (value: V) => void;
}) {
  return (
    <div class="segmented" role="group">
      {props.options.map(({ value, label, ...data }) => (
        <button
          type="button"
          key={value}
          aria-pressed={props.value === value ? 'true' : 'false'}
          onClick={() => props.onChange(value)}
          {...data}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function Select<V extends string>(
  props: {
    options: { value: V; label: string }[];
    value: V;
    onChange: (value: V) => void;
  } & DataAttributes,
) {
  const { options, value, onChange, ...rest } = props;
  const handle = (event: JSX.TargetedEvent<HTMLSelectElement>) =>
    onChange(event.currentTarget.value as V);
  return (
    <select value={value} onChange={handle} {...rest}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Field(props: { label: string; children: preact.ComponentChildren }) {
  return (
    <label class="field">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}
