import React, { useEffect, useRef, useState } from 'react';
import { TextInput } from '@inkjs/ui';

export interface IMETextInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  isDisabled?: boolean;
  cursorYOffset?: number;
  cursorXOffset?: number;
}

export const IMETextInput: React.FC<IMETextInputProps> = ({
  value,
  onChange,
  placeholder,
  isDisabled = false,
  cursorYOffset: _cursorYOffset,
  cursorXOffset: _cursorXOffset = 0,
}) => {
  const pendingDefaultRef = useRef(value);
  const mirroredValueRef = useRef(value);
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    if (value === mirroredValueRef.current) {
      return;
    }

    pendingDefaultRef.current = value;
    mirroredValueRef.current = value;
    setResetKey((previous) => previous + 1);
  }, [value]);

  const handleChange = (nextValue: string): void => {
    mirroredValueRef.current = nextValue;
    onChange(nextValue);
  };

  return (
    <TextInput
      key={resetKey}
      defaultValue={pendingDefaultRef.current}
      placeholder={placeholder ?? ''}
      isDisabled={isDisabled}
      onChange={handleChange}
    />
  );
};
