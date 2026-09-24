"""Bounded decisions only. Commands execute through the enrolled common controller.
No provider calls, ownership adoption, retries, new pin contexts or evidence invention.
"""
PIN_RANGES = 2**27

def next_action(state, now_ms, driver, actions=0):
    def stop(reason): return {'action':'stop','reason':reason,'resumeAuthorized':False}
    def op(name, intent=None):
        out={'action':'command','command':'operate','operation':name}
        if intent is not None: out['intent']=intent
        return out
    if not isinstance(state,dict) or not isinstance(driver,dict): raise ValueError('Invalid adaptive input')
    deadline=driver.get('deadlineMs'); limit=driver.get('maxActions')
    if type(deadline) is not int or type(limit) is not int or not 1<=limit<=100000: raise ValueError('Invalid adaptive bounds')
    if now_ms>=deadline: return stop('deadline')
    if actions>=limit: return stop('action_limit')
    owner=state.get('owner') or {}; parent=state.get('parent') or {}; child=state.get('child')
    if owner.get('activeOperation') or owner.get('status')!='owned': return stop('owner_unsettled')
    for scope in [parent]+([child] if child else []):
        if scope.get('identityConflict') or scope.get('dispatchClosed'): return stop('scope_closed_or_conflicted')
    rows=state.get('pinIntents',[]) if owner.get('lifecycle')=='pin' else state.get('subsetIntents',[])
    if not isinstance(rows,list) or len({r['sk'] for r in rows})!=len(rows): raise ValueError('Invalid intent inventory')
    for r in rows:
        index=r.get('index') or {}
        if r.get('identityConflict') or index.get('ambiguous') or index.get('count',0)>1: return stop('ambiguous_provider_identity')
        if r.get('state')=='uncertain': return stop('uncertain_submission_requires_reconciliation')
        if r.get('terminalStatus') in ['FAILED','CANCELLED','TIMED_OUT']: return stop('provider_failure')
    if owner.get('lifecycle')=='pin':
        if parent.get('phase')=='pinning_draining':
            if now_ms>=driver.get('subsetSubmissionCutoffMs',0): return stop('subset_submission_cutoff')
            winners=[r for r in rows if r.get('state')=='candidate' and r.get('candidateVerified') is True and r.get('terminalStatus')=='COMPLETED' and r.get('provider')]
            if len(winners)!=1: return stop('pin_winner_not_unique_verified')
            if any(r.get('provider') and not r.get('terminalStatus') for r in rows): return stop('pin_siblings_not_terminal')
            d=state.get('parentDrain')
            if not d or any(k not in d for k in ['workersMin','workersMax','queued','inProgress','observedAtMs']): return {'action':'wait','reason':'pin_drain_observation_unavailable','operatorActionRequired':True}
            if any(d.get(k)!=0 for k in ['workersMin','workersMax','queued','inProgress']):
                return op('extend',winners[0]['sk']) # Enrolled common owns verified disable and drain.
            if type(d.get('observedAtMs')) is not int or not 0<=now_ms-d['observedAtMs']<=60000: return {'action':'wait','reason':'pin_drain_observation_stale'}
            return op('extend',winners[0]['sk'])
        if parent.get('phase')!='pinning_searching': return stop('pin_phase_not_searchable')
        active=[r for r in rows if r.get('state') in ['reserved','attached']]
        if len(active)>1: return stop('one_worker_slot_required')
        if active:
            r=active[0]
            if r['state']=='attached': return op('poll',r['sk'])
        budget=parent.get('budget') or {}
        if now_ms>=budget.get('deadlineMs',0) or budget.get('claimed',0)>=budget.get('maxSubmissions',0): return stop('pin_budget_exhausted')
        if now_ms>=driver.get('pinSubmissionCutoffMs',0): return stop('pin_submission_cutoff')
        if active: return op('submit',active[0]['sk'])
        seen=set()
        for r in rows:
            if not r['sk'].startswith('PIN#') or not r['sk'][4:].isdigit() or r.get('state')!='range_complete': return stop('unrecognized_pin_coverage')
            n=int(r['sk'][4:]);
            if str(n)!=r['sk'][4:] or not 0<=n<PIN_RANGES: raise ValueError('Invalid pin rank')
            seen.add(n)
        attempt=parent.get('pinResumeFloor',0)
        if type(attempt) is not int or not 0<=attempt<PIN_RANGES: raise ValueError('Invalid pin resume floor')
        while attempt in seen: attempt+=1
        if attempt>=PIN_RANGES: return stop('pin_domain_exhausted')
        return op('reserve','PIN#'+str(attempt))
    if owner.get('lifecycle')=='subset' and child:
        if child.get('phase')=='awaiting_authorization':
            if child.get('signingPreparation'): return stop('signing_preparation_complete')
            return op('prepare_solved_state')
        if child.get('phase') not in ['searching','draining']: return stop('subset_phase_not_searchable')
        # Existing durable scheduler validates every range receipt and handles phase advance.
        # Its terminal reason is surfaced by the wrapper; never loop domain/budget errors.
        previous=state.get('lastOperationResult')
        if isinstance(previous,dict) and previous.get('reason') in ['reconcile','stopped','budget_exhausted','domain_exhausted','paused','aborted','deadline','submission_cutoff']:
            return stop('subset_'+previous['reason'])
        return op('run')
    return stop('unsupported_lifecycle')
