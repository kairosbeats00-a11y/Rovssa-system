import fs from 'node:fs'
import solc from 'solc'

const source = fs.readFileSync('contracts/Observation.sol', 'utf8')
const input = {
  language: 'Solidity',
  sources: { 'Observation.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
}
const output = JSON.parse(solc.compile(JSON.stringify(input), {
  import: path => ({ contents: fs.readFileSync('node_modules/' + path, 'utf8') }),
}))
for (const error of output.errors || []) {
  if (error.severity === 'error') throw new Error(error.formattedMessage)
}
const { abi, evm } = output.contracts['Observation.sol'].Observation
fs.writeFileSync('src/observation-contract.json', JSON.stringify({ abi, bytecode: '0x' + evm.bytecode.object }) + '\n')

