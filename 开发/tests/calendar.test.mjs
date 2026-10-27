import test from 'node:test';
import assert from 'node:assert/strict';
import {todayInZone,addCalendarDays,calendarDayDifference,sevenDayWindow} from '../src/calendar.mjs';

test('AC20 七天含今天及第六天，同日不同ID分别计数，逾期独立',()=>{
 const items=[['today1','2026-10-23'],['today2','2026-10-23'],['six','2026-10-29'],['seven','2026-10-30'],['late','2026-10-22'],['none',''],['done','2026-10-23','done'],['deleted','2026-10-23','pending',true],['bad','2026-02-30']].map(([id,dueDate,status='pending',deletedAt])=>({id,dueDate,status,deletedAt}));
 items.push({...items[0]});const actual=sevenDayWindow(items,'Asia/Shanghai',new Date('2026-10-23T04:00:00Z'));
 assert.deepEqual(actual.upcoming.map(x=>x.id),['today1','today2','six']);assert.deepEqual(actual.overdue.map(x=>x.id),['late']);assert.equal(actual.endExclusive,'2026-10-30');
});
test('AC21 同一UTC时刻在用户选择时区得到正确今天和范围',()=>{
 const now=new Date('2026-10-23T16:30:00Z');assert.equal(todayInZone('Asia/Shanghai',now),'2026-10-24');assert.equal(todayInZone('America/New_York',now),'2026-10-23');
 const items=[{id:'one',dueDate:'2026-10-23',status:'pending'}];assert.equal(sevenDayWindow(items,'Asia/Shanghai',now).overdue.length,1);assert.equal(sevenDayWindow(items,'America/New_York',now).upcoming.length,1);assert.equal(items[0].dueDate,'2026-10-23');
});
test('跨夏令时开始/结束均按日历天计算，不出现23/25小时偏差',()=>{
 for(const [from,to]of [['2026-03-07','2026-03-09'],['2026-10-31','2026-11-02']]){assert.equal(calendarDayDifference(from,to),2);assert.equal(addCalendarDays(from,2),to);}
 assert.equal(todayInZone('America/New_York',new Date('2026-03-08T06:59:00Z')),'2026-03-08');assert.equal(todayInZone('America/New_York',new Date('2026-03-08T07:01:00Z')),'2026-03-08');
});
test('跨月、跨年、闰年以及非法日期拒绝',()=>{
 assert.equal(addCalendarDays('2026-12-31',1),'2027-01-01');assert.equal(addCalendarDays('2028-02-28',1),'2028-02-29');assert.equal(addCalendarDays('2026-03-01',-1),'2026-02-28');assert.throws(()=>calendarDayDifference('2026-02-29','2026-03-01'),RangeError);assert.throws(()=>addCalendarDays('2026-01-01',.5),RangeError);
});
