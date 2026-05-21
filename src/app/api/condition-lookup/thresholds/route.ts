import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { ConditionThreshold } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export async function GET() {
  const supabase: AnyClient = await createClient()
  const { data, error } = await supabase
    .from('condition_thresholds')
    .select('*')
    .order('metric') as { data: ConditionThreshold[] | null; error: { message: string } | null }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ thresholds: data ?? [] })
}
