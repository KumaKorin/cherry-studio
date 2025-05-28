export function readableStreamAsyncIterable<T>(stream: ReadableStream<T>): AsyncIterable<T> {
  const reader = stream.getReader()
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        async next(): Promise<IteratorResult<T>> {
          return reader.read() as Promise<IteratorResult<T>>
        }
      }
    }
  }
}

export function asyncGeneratorToReadableStream<T>(gen: AsyncIterable<T>): ReadableStream<T> {
  const iterator = gen[Symbol.asyncIterator]()

  return new ReadableStream<T>({
    async pull(controller) {
      const { value, done } = await iterator.next()
      if (done) {
        controller.close()
      } else {
        controller.enqueue(value)
      }
    }
  })
}
