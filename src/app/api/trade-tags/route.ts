import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export async function GET() {
  const supabase: AnyClient = await createClient()
  const { data } = await supabase.from('trade_tags').select('*').order('sort_order')
  return NextResponse.json(data ?? [])
}
