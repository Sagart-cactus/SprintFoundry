/**
 * Returns a greeting message.
 *
 * This is a simple hello world function that returns the classic
 * "Hello, World!" string. It can be used as a basic test function
 * or as an example of a simple utility function.
 *
 * @returns {string} The greeting message "Hello, World!"
 *
 * @example
 * ```typescript
 * const greeting = hello();
 * console.log(greeting); // Output: "Hello, World!"
 * ```
 */
export function hello(): string {
  return 'Hello, World!';
}

/**
 * Logs a greeting message to the console.
 *
 * This function outputs the classic "Hello, World!" message directly
 * to the console using console.log. It's useful for quick testing
 * and demonstration purposes.
 *
 * @returns {void}
 *
 * @example
 * ```typescript
 * logHello(); // Output: Hello, World!
 * ```
 */
export function logHello(): void {
  console.log('Hello, World!');
}
