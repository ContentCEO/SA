/**
 * A problem with the whole form (say the save failed), not one field: shown above the button,
 * in words, with everything they typed still in place. useFocusFirstError moves focus here.
 */
export function FormError({ errors }: { errors?: string[] }) {
  if (!errors?.length) return null;
  return (
    <p
      role="alert"
      tabIndex={-1}
      data-form-error
      className="rounded-lg border-2 border-current p-3 font-semibold outline-none"
    >
      {errors[0]}
    </p>
  );
}
