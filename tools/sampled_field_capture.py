"""Capture literal sampled fields and verified local bake payloads without running a solver."""
from __future__ import annotations

import base64
import copy
from pathlib import Path
import re

from import_samples import strict_json, canonical_json, sha256, integer, SampleImportDiagnostic, MAX_BYTES, IDENTIFIER
from space3d_capture import _span

MAX_CAPTURE_BYTES = 2_000_000
MAX_TOTAL_BYTES = 16_000_000


class SampledFieldCaptureDiagnostic(ValueError):
    def __init__(self, code, message, source_span=None):
        super().__init__(f'{code}: {message}')
        self.code, self.sourceSpan = code, source_span


def fail(code, message, span=None):
    raise SampledFieldCaptureDiagnostic(code, message, span)


def save(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix+'.tmp'); temporary.write_bytes(raw); temporary.replace(path)


def parse(raw, span):
    try: return strict_json(raw, span)
    except SampleImportDiagnostic as error:
        raise SampledFieldCaptureDiagnostic(error.code, str(error).split(': ',1)[-1], span) from error


def local_path(base, relative, span):
    if (not isinstance(relative, str) or len(relative)>2048 or
        not re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*',relative) or
        any(part in ('.','..') for part in relative.split('/'))):
        fail('BAKE_CAPTURE_PATH', 'Expected a portable relative local path without dot segments.', span)
    candidate = (base/relative).resolve()
    if not candidate.is_relative_to(base.resolve()) or not candidate.is_file():
        fail('BAKE_CAPTURE_PATH', f'Missing or redirected local file: {relative}', span)
    return candidate


def read_sidecar(execution, output, base, field, budget):
    if not isinstance(base,str) or not re.fullmatch(r'scene\.tl-samples-[1-9][0-9]*',base):
        fail('SAMPLES_CAPTURE_PATH','Invalid generated sidecar.')
    path=execution/f'{base}.{field}.txt'
    if not path.is_file() or path.resolve().parent!=execution.resolve(): fail('SAMPLES_CAPTURE_PATH','Missing or redirected sidecar.')
    limit=2048 if field=='id' else MAX_CAPTURE_BYTES
    if path.stat().st_size>limit or budget[0]+path.stat().st_size>MAX_TOTAL_BYTES: fail('SAMPLES_CAPTURE_BUDGET','Capture byte limit exceeded.')
    raw=path.read_bytes();budget[0]+=len(raw)
    try:text=raw.decode('utf8')
    except UnicodeError as error:raise SampledFieldCaptureDiagnostic('SAMPLES_CAPTURE_UTF8','Expected strict UTF-8 sidecar.') from error
    archive=output/'bake-sources'/path.name;save(archive,raw)
    return text,_span(text,archive,output)


def hydrate_manifest(path, output, base, budget, declaration_span):
    budget[1]+=path.stat().st_size
    if budget[1]>MAX_TOTAL_BYTES:fail('BAKE_CAPTURE_BUDGET','Combined manifests exceed 16 MB.',declaration_span)
    raw=path.read_bytes();archive=output/'bake-sources'/f'{base}.manifest.json';save(archive,raw)
    try:text=raw.decode('utf8')
    except UnicodeError as error:raise SampledFieldCaptureDiagnostic('BAKE_CAPTURE_UTF8','Manifest must be strict UTF-8.',declaration_span) from error
    span=_span(text,archive,output);manifest=parse(text,span)
    if not isinstance(manifest,dict) or not isinstance(manifest.get('chunks'),list) or not 1<=len(manifest['chunks'])<=256:
        fail('BAKE_CAPTURE_MANIFEST','Expected a manifest with 1..256 chunks.',span)
    result=copy.deepcopy(manifest);sources=[]
    for i,chunk in enumerate(manifest['chunks']):
        if not isinstance(chunk,dict) or not integer(chunk.get('byteLength'),1,MAX_BYTES) or not isinstance(chunk.get('sha256'),str) or not re.fullmatch(r'[0-9a-f]{64}',chunk['sha256']):
            fail('BAKE_CAPTURE_CHUNK','Chunk requires bounded byteLength and lowercase SHA-256.',span)
        size=chunk['byteLength'];budget[0]+=size
        if budget[0]>MAX_BYTES:fail('BAKE_CAPTURE_BUDGET','Combined bake payloads exceed 64 MiB.',span)
        source=chunk.get('source')
        if not isinstance(source,dict):fail('BAKE_CAPTURE_CHUNK','Expected a chunk source.',span)
        if source.get('kind')=='inline':
            if set(source)!={'kind','data'} or not isinstance(source.get('data'),str) or len(source['data'])>4*((size+2)//3):
                fail('BAKE_CAPTURE_CHUNK','Invalid bounded inline chunk.',span)
            try:payload=base64.b64decode(source['data'],validate=True)
            except (ValueError,TypeError) as error:raise SampledFieldCaptureDiagnostic('BAKE_CAPTURE_ENCODING','Invalid base64 chunk.',span) from error
            if base64.b64encode(payload).decode('ascii')!=source['data']:fail('BAKE_CAPTURE_ENCODING','Base64 must be canonical.',span)
        elif source.get('kind')=='external':
            if not {'kind','uri'}<=set(source)<={'kind','uri','byteRange'}:fail('BAKE_CAPTURE_CHUNK','Invalid external chunk fields.',span)
            source_path=local_path(path.parent,source.get('uri'),span);file_size=source_path.stat().st_size
            if file_size>MAX_BYTES:fail('BAKE_CAPTURE_BUDGET','External file exceeds 64 MiB.',span)
            offset,length=0,file_size
            if 'byteRange' in source:
                part=source['byteRange']
                if not isinstance(part,dict) or set(part)!={'offset','length'} or not integer(part.get('offset'),0,MAX_BYTES) or not integer(part.get('length'),1,MAX_BYTES):
                    fail('BAKE_CAPTURE_RANGE','Invalid external byte range.',span)
                offset,length=part['offset'],part['length']
            if length!=size or offset+length>file_size:fail('BAKE_CAPTURE_RANGE','Chunk length/range disagrees with its file.',span)
            with source_path.open('rb') as stream:stream.seek(offset);payload=stream.read(length)
        else:fail('BAKE_CAPTURE_CHUNK','Expected inline or external chunk source.',span)
        if len(payload)!=size or sha256(payload)!=chunk['sha256']:fail('BAKE_CAPTURE_HASH','Chunk byte length or SHA-256 does not match.',span)
        chunk_archive=output/'bake-sources'/f'{base}.chunk-{i:03d}.bin';save(chunk_archive,payload)
        result['chunks'][i]['source']={'kind':'inline','data':base64.b64encode(payload).decode('ascii')}
        sources.append({'id':chunk.get('id'),'file':chunk_archive.relative_to(output).as_posix(),'sha256':sha256(payload),'byteLength':len(payload)})
    return result,{'manifest':archive.relative_to(output).as_posix(),'manifestSha256':sha256(raw),'manifestSourceSpan':span,'chunks':sources}


def lower_sampled_fields(records,bundle,execution,output,source):
    declarations=[r for r in records if r.get('type')=='samples-file']
    if not declarations:return None
    if len(declarations)>32:fail('SAMPLES_CAPTURE_BUDGET','At most 16 bakes and 16 sampled field operations are supported.')
    execution,output,source=Path(execution),Path(output),Path(source)
    bakes,operations,metadata,files,opids={},{},[],set(),set()
    capture_budget,payload_budget=[0],[0,0]
    for record in declarations:
        base=record.get('file');kind=record.get('kind')
        if not isinstance(base,str) or base in files:fail('SAMPLES_CAPTURE_DUPLICATE','Duplicate or invalid declaration sidecar.')
        files.add(base)
        text,span=read_sidecar(execution,output,base,'body',capture_budget)
        identifier,idspan=read_sidecar(execution,output,base,'id',capture_budget);identifier=identifier.strip()
        if not IDENTIFIER.fullmatch(identifier):fail('SAMPLES_CAPTURE_ID','Expected a literal identifier of at most 512 characters.',idspan)
        if kind=='bake':
            if identifier in bakes or identifier in bundle.get('bakes',{}):fail('SAMPLES_CAPTURE_DUPLICATE','Duplicate bake identifier.',idspan)
            if len(bakes)>=16:fail('SAMPLES_CAPTURE_BUDGET','At most 16 bakes are supported.',span)
            manifest_path=local_path(source.parent,text.strip(),span)
            bakes[identifier],info=hydrate_manifest(manifest_path,output,base,payload_budget,span)
        elif kind=='field':
            if identifier in opids:fail('SAMPLES_CAPTURE_DUPLICATE','Duplicate sampled-field operation identifier.',idspan)
            if len(operations)>=16:fail('SAMPLES_CAPTURE_BUDGET','At most 16 sampled fields are supported.',span)
            value=parse(text,span)
            if not isinstance(value,dict) or any(k in value for k in ['id','sourceSpan','expressionSpan','expressionSpans']):
                fail('SAMPLES_CAPTURE_FIELD','Expected an operation object without reserved identity/source metadata.',span)
            opids.add(identifier);operations[identifier]={**value,'id':identifier,'sourceSpan':span};info={}
        else:fail('SAMPLES_CAPTURE_KIND','Unknown samples declaration kind.',span)
        metadata.append({'kind':kind,'id':identifier,'sourceSpan':span,'idSourceSpan':idspan,**info})
    if operations and 'sampledFields' in bundle:fail('SAMPLES_CAPTURE_DUPLICATE','A sampled-fields program already exists.')
    # Commit only after every local payload passes integrity checks. Shared TS
    # validation subsequently checks manifest semantics and mesh compatibility.
    if bakes:bundle['bakes']={**bundle.get('bakes',{}),**bakes}
    if operations:bundle['sampledFields']={'version':1,'operations':list(operations.values())}
    bundle['version']='0.3';report={'version':1,'declarations':metadata}
    save(output/'bake-sources'/'declarations.json',canonical_json(report))
    return report
