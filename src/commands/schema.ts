import { z } from 'zod'
import { Annotation } from '../schema.ts'

export const usage = 'schema   print the annotation JSON Schema'

export function run(): number {
  console.log(JSON.stringify(z.toJSONSchema(Annotation, { io: 'input' }), null, 2))
  return 0
}
