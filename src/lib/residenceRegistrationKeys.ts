/** Shared read keys; importing them does not load mutation feedback. */
export const residenceRegistrationKeys = {
  customer: (customerId: string) => ['residence-registrations', customerId] as const,
};
