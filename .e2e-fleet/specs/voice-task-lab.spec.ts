import { test, expect, type Page } from '@playwright/test';

async function enter(page: Page) {
  await page.goto('/');
  await page.getByLabel('Mã truy cập', {exact:true}).fill('test-voice-lab-code');
  await page.getByRole('button', {name:'Vào bản thử nghiệm'}).click();
  await expect(page.getByRole('button', {name:'Bắt đầu ghi âm'})).toBeVisible();
}

async function fakeMicrophone(page: Page) {
  await page.addInitScript(() => {
    const state = {stops:0};
    Object.defineProperty(window, '__voiceTest', {value:state});
    Object.defineProperty(navigator, 'mediaDevices', {configurable:true,value:{getUserMedia:async()=>({getTracks:()=>[{stop:()=>{state.stops++;}}]})}});
    class Recorder {
      static isTypeSupported() {return true;}
      state = 'inactive'; mimeType='audio/wav';
      ondataavailable: ((event:{data:Blob})=>void)|null=null;
      onstop: (()=>void)|null=null; onerror: (()=>void)|null=null;
      start() {this.state='recording';}
      stop() {
        this.state='inactive';
        const buffer=new ArrayBuffer(16044),view=new DataView(buffer);
        const word=(offset:number,text:string)=>{for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i));};
        word(0,'RIFF');view.setUint32(4,16036,true);word(8,'WAVE');word(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,8000,true);view.setUint32(28,16000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);word(36,'data');view.setUint32(40,16000,true);
        queueMicrotask(()=>{this.ondataavailable?.({data:new Blob([buffer],{type:'audio/wav'})});this.onstop?.();});
      }
    }
    Object.defineProperty(window,'MediaRecorder',{configurable:true,value:Recorder});
  });
}

test('mobile recording to draft, human correction and durable score preserve original', async ({page}, testInfo) => {
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await fakeMicrophone(page);
  await enter(page);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('mobile-record.png'),fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'Bắt đầu ghi âm'}).click();
  await page.getByRole('button',{name:'Dừng ghi âm'}).click();
  await expect(page.getByLabel('Nghe lại bản ghi âm')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {__voiceTest:{stops:number}}).__voiceTest.stops)).toBeGreaterThan(0);
  await page.getByRole('button',{name:'Chuyển thành văn bản'}).click();
  await expect(page.getByLabel('Văn bản đã nhận dạng')).toHaveValue(/Sửa vòi nước/);
  await page.getByRole('button',{name:'Phân tích công việc',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Sửa vòi nước',exact:true})).toBeVisible();
  await expect(page.getByText('Công việc thử nghiệm · Chưa ghi vào CRM')).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('mobile-draft.png'),fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'Đánh giá kết quả'}).click();
  const groups=page.getByRole('radiogroup').filter({has:page.getByRole('radio',{name:'Đúng',exact:true})});
  await expect(groups).toHaveCount(7);
  for (let i=0;i<7;i++) {
    const name=i===2?'Sai':'Đúng';
    await groups.nth(i).getByText(name,{exact:true}).click();
    await expect(groups.nth(i).getByRole('radio',{name,exact:true})).toBeChecked();
  }
  await page.locator('#expected-room').fill('202');
  await page.getByRole('radiogroup',{name:'Mức hữu ích từ 1 đến 5'}).getByText('4',{exact:true}).click();
  const saved=page.waitForResponse(response=>response.url().endsWith('/api/evaluations')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Lưu đánh giá',exact:true}).click();
  const response=await saved;expect(response.status()).toBe(200);
  const body=await response.json();
  expect(body.record.predicted.room).toBe('201');expect(body.record.expected.room).toBe('202');
  expect(body.record.transcriptSource).toBe('9router');expect(body.record.verdicts.room).toBe('incorrect');
  expect(body.summary.groups.find((group:{transcriptSource:string})=>group.transcriptSource==='9router').fieldAccuracy).toBeCloseTo(600/7);
  await expect(page.getByText('Đã lưu lượt đánh giá',{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByText('Nhật ký thử nghiệm',{exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});

test('editing recognized speech is labelled manual and stale predictions cannot be saved', async ({page}) => {
  await fakeMicrophone(page);await enter(page);
  await page.getByRole('button',{name:'Bắt đầu ghi âm'}).click();await page.getByRole('button',{name:'Dừng ghi âm'}).click();
  await page.getByRole('button',{name:'Chuyển thành văn bản'}).click();
  await page.getByLabel('Văn bản đã nhận dạng').fill('Sửa vòi nước phòng 202; bản chữ đã được con người sửa.');
  await page.getByRole('button',{name:'Phân tích công việc',exact:true}).click();
  await page.getByRole('button',{name:'Đánh giá kết quả'}).click();
  await page.getByRole('radiogroup',{name:'Mức hữu ích từ 1 đến 5'}).getByText('4',{exact:true}).click();
  const manualSave=page.waitForResponse(response=>response.url().endsWith('/api/evaluations')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Lưu đánh giá',exact:true}).click();
  const manualRecord=(await (await manualSave).json()).record;
  expect(manualRecord.transcriptSource).toBe('manual');
  expect(manualRecord.sttModel).toBeNull();
  expect(manualRecord.latencyMs.transcription).toBeNull();
  await page.getByRole('button',{name:'Thử một công việc khác'}).click();
  await page.getByRole('button',{name:'Nhập chữ',exact:true}).click();
  await page.getByLabel('Nhập việc cần làm').fill('Sửa vòi nước phòng 202.');
  await page.getByRole('button',{name:'Phân tích công việc',exact:true}).click();
  await page.getByRole('button',{name:'Sửa văn bản'}).click();
  await page.getByLabel('Nhập việc cần làm').fill('Nội dung đã đổi sau khi phân tích.');
  await page.getByRole('button',{name:/3 Đánh giá/}).click();
  await expect(page.getByRole('button',{name:'Lưu đánh giá',exact:true})).toBeDisabled();
});

test('unavailable provider keeps recording usable and never fabricates a draft', async ({page}) => {
  await fakeMicrophone(page);
  await page.route('**/api/status',route=>route.fulfill({json:{authenticated:true,chatModels:[],sttModels:[],defaultChatModel:null,defaultSttModel:null,providerReady:false,capabilityError:'Khóa 9Router chưa hợp lệ (401).'}}));
  await page.route('**/api/evaluations',route=>route.fulfill({json:{records:[],summary:{totalRecords:0,reviewedFields:0,correctFields:0,fieldAccuracy:null,ratedRecords:0,usefulRecords:0,usefulnessRate:null,fullyReviewedRecords:0,fullyCorrectRecords:0,fullCorrectRate:null,groups:[]}}}));
  await page.goto('/');
  await expect(page.getByText('9Router chưa sẵn sàng',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Bắt đầu ghi âm'}).click();await page.getByRole('button',{name:'Dừng ghi âm'}).click();
  await expect(page.getByRole('button',{name:'Chuyển thành văn bản'})).toBeDisabled();
  await expect(page.getByLabel('Nghe lại bản ghi âm')).toBeVisible();
  await expect(page.getByRole('heading',{name:'Sửa vòi nước',exact:true})).toHaveCount(0);
});
