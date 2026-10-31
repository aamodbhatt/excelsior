import { describe, expect, it } from 'vitest';
import { evalFormula } from './helpers';

/** Conformance table: [formula, expected value]. Fixture cells are set up below for every case. */
const fixture = {
  A1: 1,
  A2: 2,
  A3: 3,
  A4: 'text',
  A5: true,
  B1: 10,
  B2: 20,
  B3: 30,
  C1: 'apple',
  C2: 'banana',
  C3: 'cherry',
  D1: '=SEQUENCE(3)',
};

const cases: [string, unknown][] = [
  // arithmetic and operators
  ['=1+2*3', 7],
  ['=-2^2', 4],
  ['=2^3^2', 64],
  ['=10/4', 2.5],
  ['=1/0', '#DIV/0!'],
  ['=50%', 0.5],
  ['="a"&1&TRUE', 'a1TRUE'],
  ['="10"+1', 11],
  ['="x"+1', '#VALUE!'],
  ['=1<2', true],
  ['="a"="A"', true],
  ['="b">"a"', true],
  ['=1<"a"', true],
  ['=SUM(A1:A3*B1:B3)', 140],
  ['=SUM(SEQUENCE(3)+SEQUENCE(1,2))', 21],
  // math
  ['=SUM(A1:A5)', 6],
  ['=SUM(A1:A3,10,"5")', 21],
  ['=PRODUCT(A1:A3)', 6],
  ['=ROUND(2.675,2)', 2.68],
  ['=ROUND(-1.5,0)', -2],
  ['=ROUNDUP(3.21,1)', 3.3],
  ['=ROUNDDOWN(3.29,1)', 3.2],
  ['=MOD(-3,2)', 1],
  ['=INT(-1.5)', -2],
  ['=TRUNC(-1.5)', -1],
  ['=ABS(-3)', 3],
  ['=SQRT(-1)', '#NUM!'],
  ['=LN(EXP(2))', 2],
  ['=LOG(1000)', 3],
  ['=POWER(2,10)', 1024],
  ['=TANH(0)', 0],
  ['=SUMPRODUCT(A1:A3,B1:B3)', 140],
  ['=SUMIF(A1:A3,">1",B1:B3)', 50],
  ['=SUMIFS(B1:B3,A1:A3,">=2",A1:A3,"<3")', 20],
  ['=COUNTIF(C1:C3,"*an*")', 1],
  ['=COUNTIFS(A1:A3,">1",B1:B3,"<30")', 1],
  ['=AVERAGEIF(A1:A3,"<>2")', 2],
  // matrices
  ['=SUM(MMULT({1,2;3,4},{5;6}))', 56],
  ['=INDEX(MMULT({1,2;3,4},{5,6;7,8}),2,2)', 50],
  ['=MMULT({1,2},{1,2})', '#VALUE!'],
  ['=INDEX(TRANSPOSE({1,2,3}),3,1)', 3],
  ['=ROWS(TRANSPOSE(A1:B3))', 2],
  ['=SUM(SEQUENCE(4,1,2,3))', 26],
  // logical
  ['=IF(A1>0,"pos","neg")', 'pos'],
  ['=IF(FALSE,1/0,7)', 7],
  ['=IFERROR(1/0,"oops")', 'oops'],
  ['=IFNA(NA(),"na")', 'na'],
  ['=IFS(A1>5,"big",A1>0,"small")', 'small'],
  ['=SWITCH(2,1,"one",2,"two","other")', 'two'],
  ['=CHOOSE(2,"a","b","c")', 'b'],
  ['=AND(TRUE,A5,1)', true],
  ['=OR(FALSE,0)', false],
  ['=XOR(TRUE,TRUE)', false],
  ['=NOT(0)', true],
  ['=SUM(IF(A1:A3>1,B1:B3,0))', 50],
  // text
  ['=LEN("hello")', 5],
  ['=LEFT("hello",2)&RIGHT("hello",2)', 'helo'],
  ['=MID("spreadsheet",7,5)', 'sheet'],
  ['=UPPER("abc")&LOWER("DEF")', 'ABCdef'],
  ['=TRIM("  a   b ")', 'a b'],
  ['=SUBSTITUTE("a-b-c","-","+")', 'a+b+c'],
  ['=SUBSTITUTE("a-b-c","-","+",2)', 'a-b+c'],
  ['=FIND("b","abcb")', 2],
  ['=SEARCH("B","abcb",3)', 4],
  ['=TEXT(0.256,"0.0%")', '25.6%'],
  ['=TEXT(1234.5,"#,##0.00")', '1,234.50'],
  ['=VALUE("1.5")', 1.5],
  ['=TEXTJOIN("-",TRUE,"a","","b")', 'a-b'],
  ['=CONCAT(C1:C2)', 'applebanana'],
  ['=REPT("ab",3)', 'ababab'],
  ['=CODE(CHAR(65))', 65],
  // lookup
  ['=VLOOKUP(2,A1:B3,2,FALSE)', 20],
  ['=VLOOKUP(2.5,A1:B3,2)', 20],
  ['=HLOOKUP(2,{1,2,3;"a","b","c"},2,FALSE)', 'b'],
  ['=INDEX(B1:B3,2)', 20],
  ['=INDEX(A1:B3,3,2)', 30],
  ['=MATCH("banana",C1:C3,0)', 2],
  ['=MATCH(2.5,A1:A3)', 2],
  ['=MATCH("zzz",C1:C3,0)', '#N/A'],
  ['=XLOOKUP("cherry",C1:C3,B1:B3)', 30],
  ['=XLOOKUP("kiwi",C1:C3,B1:B3,"none")', 'none'],
  ['=XLOOKUP(25,B1:B3,A1:A3,,-1)', 2],
  ['=XMATCH(25,B1:B3,1)', 3],
  ['=XMATCH("b*",C1:C3,2)', 2],
  ['=ROW()', 1000],
  ['=COLUMN(C5)', 3],
  ['=ROWS(A1:A3)*COLUMNS(A1:B1)', 6],
  ['=SUM(FILTER(B1:B3,A1:A3<>2))', 40],
  ['=INDEX(SORT({3;1;2}),1)', 1],
  ['=INDEX(SORT({3;1;2},1,-1),1)', 3],
  ['=ROWS(UNIQUE({1;2;1;3}))', 3],
  ['=SUM(TAKE(SEQUENCE(10),3))', 6],
  ['=SUM(DROP(SEQUENCE(10),8))', 19],
  ['=ROWS(VSTACK({1;2},{3}))', 3],
  ['=COLUMNS(HSTACK({1;2},{3;4}))', 2],
  ['=SUM(CHOOSEROWS(B1:B3,1,-1))', 40],
  ['=COLUMNS(TOROW(A1:B3))', 6],
  ['=ROWS(WRAPROWS(SEQUENCE(7),3))', 3],
  ['=SUM(D1#)', 6],
  // statistics
  ['=AVERAGE(A1:A3)', 2],
  ['=COUNT(A1:A5)', 3],
  ['=COUNTA(A1:A5)', 5],
  ['=COUNTBLANK(A1:A7)', 2],
  ['=MAX(A1:B3)', 30],
  ['=MIN(A1:B3)', 1],
  ['=MEDIAN(1,3,2,4)', 2.5],
  ['=VAR.S(2,4,4,4,5,5,7,9)', 32 / 7],
  ['=STDEV.P(2,4,4,4,5,5,7,9)', 2],
  ['=LARGE(B1:B3,1)', 30],
  ['=SMALL(B1:B3,2)', 20],
  ['=CORREL(A1:A3,B1:B3)', 1],
  ['=AVERAGE(A4)', '#DIV/0!'],
  // info
  ['=ISBLANK(Z1)', true],
  ['=ISNUMBER(A1)', true],
  ['=ISTEXT(A4)', true],
  ['=ISERROR(1/0)', true],
  ['=ISNA(NA())', true],
  ['=ERROR.TYPE(1/0)', 2],
  // LET / LAMBDA / higher-order
  ['=LET(x,2,y,x*3,x+y)', 8],
  ['=LAMBDA(a,b,a*b)(6,7)', 42],
  ['=LET(sq,LAMBDA(v,v*v),sq(9))', 81],
  ['=SUM(MAP(A1:A3,LAMBDA(v,v*10)))', 60],
  ['=REDUCE(0,A1:A3,LAMBDA(acc,v,acc+v*v))', 14],
  ['=INDEX(SCAN(0,A1:A3,LAMBDA(acc,v,acc+v)),3)', 6],
  ['=SUM(BYROW(A1:B3,LAMBDA(r,MAX(r))))', 60],
  ['=SUM(BYCOL(A1:B3,LAMBDA(c,SUM(c))))', 66],
  ['=SUM(MAKEARRAY(2,3,LAMBDA(r,c,r*c)))', 18],
  ['=LAMBDA(x,x)', '#CALC!'],
  ['=NOSUCHFN(1)', '#NAME?'],
  ['=undefined_name+1', '#NAME?'],
];

describe('function conformance', () => {
  it.each(cases)('%s', (formula, expected) => {
    const got = evalFormula(formula, fixture);
    if (typeof expected === 'number') expect(got).toBeCloseTo(expected, 12);
    else expect(got).toEqual(expected);
  });
});

describe('seeded randomness', () => {
  it('is deterministic per cell and differs across cells', async () => {
    const { TestBook } = await import('./helpers');
    const make = () => {
      const b = new TestBook();
      b.wb.setSettings({ seed: 42 });
      b.set('A1', '=RANDARRAY(3,2)').set('C1', '=RAND()').set('D1', '=RAND()');
      b.recalc();
      return b;
    };
    const x = make();
    const y = make();
    expect(x.get('B3')).toBe(y.get('B3'));
    expect(x.get('C1')).toBe(y.get('C1'));
    expect(x.get('C1')).not.toBe(x.get('D1'));
    const v = x.get('A1') as number;
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });
});
