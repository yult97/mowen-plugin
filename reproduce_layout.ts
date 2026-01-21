
import { htmlToNoteAtom } from './src/utils/noteAtom';

// Simulating the "Bad" HTML input that produces the issues described
const testHtml = `
<div id="content">
  <h1>16 个魔法提示词让 NotebookLM 效力大增</h1>
  
  <blockquote>
    来源：<a href="https://mp.weixin.qq.com/s/xxx">https://mp.weixin.qq.com/s/xxx</a> 作者/公众号：MacTalk 发布时间：2026年1月9日 16:07 剪藏时间：2026-01-11 14:18
  </blockquote>

  <p>有的墨问用户告诉我...</p>
  <p>我是 NotebookLM 的用户...</p>

  <p>一、结构化理解与核心问题</p>
  <p>5 个核心问题</p>

  <p>提示词：分析所有输入内容... 适用：快速抓住材料的支点...</p>

  <p>——</p>

  <p>[图片] 图片</p>
</div>
`;

console.log('Testing Layout Issues...');
const result = htmlToNoteAtom(testHtml);

function analyzeStructure(atom: any) {
    let emptyCount = 0;
    let boldParamCount = 0;
    const types: string[] = [];

    const traverse = (node: any) => {
        if (node.type === 'doc' && node.content) {
            node.content.forEach((c: any) => traverse(c));
        } else {
            types.push(node.type);

            // Check for empty paragraph
            if (node.type === 'paragraph') {
                if (!node.content || node.content.length === 0 || (node.content.length === 1 && !node.content[0].text.trim())) {
                    emptyCount++;
                }
                // Check for bold mark in *entire* paragraph (simple heuristic)
                if (node.content && node.content.some((c: any) => c.marks && c.marks.some((m: any) => m.type === 'bold'))) {
                    boldParamCount++;
                }
            }
        }
    };

    traverse(result);

    console.log('Structure Summary:');
    console.log(`- emptyParagraphCount: ${emptyCount}`);
    console.log(`- boldParagraphCount: ${boldParamCount}`);
    console.log(`- first20Types: ${types.slice(0, 20).join(', ')}`);

    // Print content preview for verifying splits
    console.log('\nContent Preview:');
    if (result.content) {
        result.content.forEach((c: any, i: number) => {
            let text = '';
            if (c.content) text = c.content.map((n: any) => n.text).join('');
            console.log(`[${i}] ${c.type}: ${text.substring(0, 50)}...`);
        });
    }
}

analyzeStructure(result);
